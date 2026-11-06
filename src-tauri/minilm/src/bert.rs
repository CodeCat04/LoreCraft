//! A BERT encoder forward pass with mean pooling, as sentence-transformers runs it.
//!
//! Each text runs alone at its own length, so there is no padding to mask. Weights are
//! stored transposed, because adding whole columns at a time reads memory in order, which
//! is what makes this fast without a matrix library.

const EPS: f32 = 1e-12;

/// One weight array, in row-major order.
#[derive(Debug, Clone)]
pub struct Tensor {
    pub shape: Vec<usize>,
    pub data: Vec<f32>,
}

struct Dense {
    /// `in_dim` rows of `out_dim` numbers.
    columns: Vec<f32>,
    bias: Vec<f32>,
    in_dim: usize,
    out_dim: usize,
}

impl Dense {
    /// PyTorch keeps a linear layer's weight as (out, in).
    fn new(weight: Tensor, bias: Tensor) -> Result<Self, String> {
        let [out_dim, in_dim] = weight.shape[..] else {
            return Err("A linear layer's weight is not a matrix.".to_string());
        };
        if bias.data.len() != out_dim {
            return Err("A linear layer's bias has the wrong size.".to_string());
        }
        let mut columns = vec![0.0; in_dim * out_dim];
        for out in 0..out_dim {
            for input in 0..in_dim {
                columns[input * out_dim + out] = weight.data[out * in_dim + input];
            }
        }
        Ok(Self { columns, bias: bias.data, in_dim, out_dim })
    }
}

struct Norm {
    gamma: Vec<f32>,
    beta: Vec<f32>,
}

struct Layer {
    query: Dense,
    key: Dense,
    value: Dense,
    attention_out: Dense,
    attention_norm: Norm,
    intermediate: Dense,
    output: Dense,
    output_norm: Norm,
}

/// How the vectors of a text's tokens become the text's vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pooling {
    /// Their average, as sentence-transformers' MiniLM models do.
    Mean,
    /// The first token's, as BGE models do.
    First,
}

pub struct Bert {
    pooling: Pooling,
    hidden: usize,
    heads: usize,
    /// The word table, `vocab` rows of `hidden`.
    word: Vec<f32>,
    /// One row of `hidden` per position.
    position: Vec<f32>,
    /// Type 0, since a text here is always a single segment.
    segment: Vec<f32>,
    embedding_norm: Norm,
    layers: Vec<Layer>,
}

// ---- Kernels ----------------------------------------------------------------

#[cfg(target_arch = "x86_64")]
fn has_avx2_fma() -> bool {
    std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")
}

#[cfg(target_arch = "x86_64")]
mod avx2 {
    use std::arch::x86_64::*;

    /// `out[t] = bias + Σ x[t][j] * columns[j]`, four columns at a time, so `out` is loaded
    /// and stored once per four multiplications.
    #[target_feature(enable = "avx2,fma")]
    pub unsafe fn dense(x: &[f32], columns: &[f32], bias: &[f32], in_dim: usize, out_dim: usize, out: &mut [f32]) {
        for (row, y) in x.chunks_exact(in_dim).zip(out.chunks_exact_mut(out_dim)) {
            y.copy_from_slice(bias);
            let y = y.as_mut_ptr();
            let mut j = 0;
            while j + 4 <= in_dim {
                let a0 = _mm256_set1_ps(row[j]);
                let a1 = _mm256_set1_ps(row[j + 1]);
                let a2 = _mm256_set1_ps(row[j + 2]);
                let a3 = _mm256_set1_ps(row[j + 3]);
                let w0 = columns.as_ptr().add(j * out_dim);
                let w1 = w0.add(out_dim);
                let w2 = w1.add(out_dim);
                let w3 = w2.add(out_dim);
                let mut k = 0;
                while k + 8 <= out_dim {
                    let mut v = _mm256_loadu_ps(y.add(k));
                    v = _mm256_fmadd_ps(a0, _mm256_loadu_ps(w0.add(k)), v);
                    v = _mm256_fmadd_ps(a1, _mm256_loadu_ps(w1.add(k)), v);
                    v = _mm256_fmadd_ps(a2, _mm256_loadu_ps(w2.add(k)), v);
                    v = _mm256_fmadd_ps(a3, _mm256_loadu_ps(w3.add(k)), v);
                    _mm256_storeu_ps(y.add(k), v);
                    k += 8;
                }
                while k < out_dim {
                    *y.add(k) += row[j] * *w0.add(k) + row[j + 1] * *w1.add(k) + row[j + 2] * *w2.add(k) + row[j + 3] * *w3.add(k);
                    k += 1;
                }
                j += 4;
            }
            while j < in_dim {
                let w = columns.as_ptr().add(j * out_dim);
                for k in 0..out_dim {
                    *y.add(k) += row[j] * *w.add(k);
                }
                j += 1;
            }
        }
    }

    #[target_feature(enable = "avx2,fma")]
    pub unsafe fn dot(a: &[f32], b: &[f32]) -> f32 {
        let n = a.len().min(b.len());
        let (pa, pb) = (a.as_ptr(), b.as_ptr());
        let mut s0 = _mm256_setzero_ps();
        let mut s1 = _mm256_setzero_ps();
        let mut i = 0;
        while i + 16 <= n {
            s0 = _mm256_fmadd_ps(_mm256_loadu_ps(pa.add(i)), _mm256_loadu_ps(pb.add(i)), s0);
            s1 = _mm256_fmadd_ps(_mm256_loadu_ps(pa.add(i + 8)), _mm256_loadu_ps(pb.add(i + 8)), s1);
            i += 16;
        }
        if i + 8 <= n {
            s0 = _mm256_fmadd_ps(_mm256_loadu_ps(pa.add(i)), _mm256_loadu_ps(pb.add(i)), s0);
            i += 8;
        }
        let s = _mm256_add_ps(s0, s1);
        let low = _mm_add_ps(_mm256_castps256_ps128(s), _mm256_extractf128_ps(s, 1));
        let low = _mm_add_ps(low, _mm_movehl_ps(low, low));
        let low = _mm_add_ss(low, _mm_shuffle_ps(low, low, 1));
        let mut total = _mm_cvtss_f32(low);
        while i < n {
            total += *pa.add(i) * *pb.add(i);
            i += 1;
        }
        total
    }

    #[target_feature(enable = "avx2,fma")]
    pub unsafe fn axpy(a: f32, x: &[f32], y: &mut [f32]) {
        let n = x.len().min(y.len());
        let va = _mm256_set1_ps(a);
        let (px, py) = (x.as_ptr(), y.as_mut_ptr());
        let mut i = 0;
        while i + 8 <= n {
            _mm256_storeu_ps(py.add(i), _mm256_fmadd_ps(va, _mm256_loadu_ps(px.add(i)), _mm256_loadu_ps(py.add(i))));
            i += 8;
        }
        while i < n {
            *py.add(i) += a * *px.add(i);
            i += 1;
        }
    }

    #[target_feature(enable = "avx2,fma")]
    pub unsafe fn gelu(values: &mut [f32]) {
        super::gelu_body(values);
    }

    #[target_feature(enable = "avx2,fma")]
    pub unsafe fn exp_in_place(values: &mut [f32]) {
        super::exp_body(values);
    }
}

fn dense(layer: &Dense, x: &[f32], out: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if has_avx2_fma() {
        // SAFETY: the features were just checked, and the sizes are checked by `chunks_exact`
        // on whole rows of `in_dim` and `out_dim`, which `columns` holds by construction.
        unsafe { avx2::dense(x, &layer.columns, &layer.bias, layer.in_dim, layer.out_dim, out) };
        return;
    }
    for (row, y) in x.chunks_exact(layer.in_dim).zip(out.chunks_exact_mut(layer.out_dim)) {
        y.copy_from_slice(&layer.bias);
        for (&a, column) in row.iter().zip(layer.columns.chunks_exact(layer.out_dim)) {
            for (value, w) in y.iter_mut().zip(column) {
                *value += a * w;
            }
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    #[cfg(target_arch = "x86_64")]
    if has_avx2_fma() {
        // SAFETY: the features were just checked, and the length is the shorter of the two.
        return unsafe { avx2::dot(a, b) };
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn axpy(a: f32, x: &[f32], y: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if has_avx2_fma() {
        // SAFETY: the features were just checked, and the length is the shorter of the two.
        unsafe { avx2::axpy(a, x, y) };
        return;
    }
    for (value, w) in y.iter_mut().zip(x) {
        *value += a * w;
    }
}

/// Cephes' single-precision exponential, written so the compiler can vectorize the loop.
#[inline(always)]
fn exp_one(x: f32) -> f32 {
    let x = x.clamp(-87.0, 88.0);
    let fx = (x * std::f32::consts::LOG2_E + 0.5).floor();
    let r = x - fx * 0.693_359_4 + fx * 2.121_944_4e-4;
    let z = r * r;
    let y = 1.987_569_1e-4_f32;
    let y = y * r + 1.398_199_9e-3;
    let y = y * r + 8.333_452e-3;
    let y = y * r + 4.166_579_6e-2;
    let y = y * r + 0.166_666_65;
    let y = y * r + 0.5;
    let y = y * z + r + 1.0;
    // SAFETY: `fx` is a finite whole number near -126..=128, since `x` was clamped.
    let exponent = unsafe { fx.to_int_unchecked::<i32>() };
    y * f32::from_bits(((exponent + 127) as u32) << 23)
}

#[inline(always)]
fn exp_body(values: &mut [f32]) {
    for value in values {
        *value = exp_one(*value);
    }
}

/// `x/2 * (1 + erf(x/sqrt 2))`, with the error function from Abramowitz and Stegun 7.1.26.
#[inline(always)]
fn gelu_body(values: &mut [f32]) {
    for value in values {
        let x = *value;
        let a = x.abs() * std::f32::consts::FRAC_1_SQRT_2;
        let t = 1.0 / (1.0 + 0.327_591_1 * a);
        let polynomial = ((((1.061_405_4_f32 * t - 1.453_152) * t + 1.421_413_8) * t - 0.284_496_72) * t + 0.254_829_6) * t;
        let erf = 1.0 - polynomial * exp_one(-a * a);
        let signed = if x < 0.0 { -erf } else { erf };
        *value = 0.5 * x * (1.0 + signed);
    }
}

fn gelu(values: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if has_avx2_fma() {
        // SAFETY: the features were just checked.
        unsafe { avx2::gelu(values) };
        return;
    }
    gelu_body(values);
}

fn exp_in_place(values: &mut [f32]) {
    #[cfg(target_arch = "x86_64")]
    if has_avx2_fma() {
        // SAFETY: the features were just checked.
        unsafe { avx2::exp_in_place(values) };
        return;
    }
    exp_body(values);
}

fn layer_norm(norm: &Norm, x: &mut [f32]) {
    let dim = norm.gamma.len();
    for row in x.chunks_exact_mut(dim) {
        let mean = row.iter().sum::<f32>() / dim as f32;
        let variance = row.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / dim as f32;
        let scale = 1.0 / (variance + EPS).sqrt();
        for ((value, gamma), beta) in row.iter_mut().zip(&norm.gamma).zip(&norm.beta) {
            *value = (*value - mean) * scale * gamma + beta;
        }
    }
}

// ---- The model --------------------------------------------------------------

impl Bert {
    /// Builds the model from weights by their PyTorch names.
    pub fn from_tensors(mut get: impl FnMut(&str) -> Option<Tensor>) -> Result<Self, String> {
        let mut need = |name: &str| get(name).ok_or_else(|| format!("The model has no weight called {name}."));
        let word = need("embeddings.word_embeddings.weight")?;
        let [_, hidden] = word.shape[..] else {
            return Err("The word table is not a matrix.".to_string());
        };
        let position = need("embeddings.position_embeddings.weight")?;
        let segment = need("embeddings.token_type_embeddings.weight")?;
        let embedding_norm = Norm {
            gamma: need("embeddings.LayerNorm.weight")?.data,
            beta: need("embeddings.LayerNorm.bias")?.data,
        };
        let mut layers = Vec::new();
        loop {
            let i = layers.len();
            let prefix = format!("encoder.layer.{i}.");
            let name = |rest: &str| format!("{prefix}{rest}");
            let Ok(weight) = need(&name("attention.self.query.weight")) else {
                break;
            };
            let mut linear = |rest: &str, weight: Option<Tensor>| -> Result<Dense, String> {
                let w = match weight {
                    Some(w) => w,
                    None => need(&name(&format!("{rest}.weight")))?,
                };
                Dense::new(w, need(&name(&format!("{rest}.bias")))?)
            };
            let query = linear("attention.self.query", Some(weight))?;
            let key = linear("attention.self.key", None)?;
            let value = linear("attention.self.value", None)?;
            let attention_out = linear("attention.output.dense", None)?;
            let intermediate = linear("intermediate.dense", None)?;
            let output = linear("output.dense", None)?;
            let attention_norm = Norm {
                gamma: need(&name("attention.output.LayerNorm.weight"))?.data,
                beta: need(&name("attention.output.LayerNorm.bias"))?.data,
            };
            let output_norm = Norm {
                gamma: need(&name("output.LayerNorm.weight"))?.data,
                beta: need(&name("output.LayerNorm.bias"))?.data,
            };
            layers.push(Layer { query, key, value, attention_out, attention_norm, intermediate, output, output_norm });
        }
        if layers.is_empty() {
            return Err("The model has no encoder layers.".to_string());
        }
        // The usual ratio. MiniLM-L6 has 12 heads of 32, and BERT base 12 of 64.
        let heads = 12;
        if hidden % heads != 0 {
            return Err("The model's size does not divide into 12 attention heads.".to_string());
        }
        Ok(Self {
            pooling: Pooling::Mean,
            hidden,
            heads,
            word: word.data,
            position: position.data,
            segment: segment.data[..hidden].to_vec(),
            embedding_norm,
            layers,
        })
    }

    pub fn with_pooling(mut self, pooling: Pooling) -> Self {
        self.pooling = pooling;
        self
    }

    /// The longest text it can read, in tokens.
    pub fn max_positions(&self) -> usize {
        self.position.len() / self.hidden
    }

    pub fn dimensions(&self) -> usize {
        self.hidden
    }

    /// `context[t] = softmax(q[t] k' / sqrt(size)) v`, for each head of `size` numbers.
    fn attend(&self, n: usize, q: &[f32], k: &[f32], v: &[f32], context: &mut [f32], scores: &mut [f32]) {
        let hidden = self.hidden;
        let size = hidden / self.heads;
        let scale = 1.0 / (size as f32).sqrt();
        context.fill(0.0);
        for head in 0..self.heads {
            let start = head * size;
            let end = start + size;
            for t in 0..n {
                let query = &q[t * hidden + start..t * hidden + end];
                for (other, score) in scores.iter_mut().enumerate() {
                    *score = dot(query, &k[other * hidden + start..other * hidden + end]) * scale;
                }
                // Softmax, relative to the largest so the exponentials stay in range.
                let top = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                for score in scores.iter_mut() {
                    *score -= top;
                }
                exp_in_place(scores);
                let total: f32 = scores.iter().sum();
                let out = &mut context[t * hidden + start..t * hidden + end];
                for (other, score) in scores.iter().enumerate() {
                    axpy(score / total, &v[other * hidden + start..other * hidden + end], out);
                }
            }
        }
    }

    /// The text's vector, with length 1. `ids` must include the start and end markers.
    pub fn encode(&self, ids: &[u32]) -> Vec<f32> {
        let hidden = self.hidden;
        let n = ids.len().clamp(1, self.max_positions());
        let vocab = self.word.len() / hidden;
        let mut x = vec![0.0_f32; n * hidden];
        for (t, row) in x.chunks_exact_mut(hidden).enumerate() {
            let id = ids.get(t).map_or(0, |id| (*id as usize).min(vocab - 1));
            let word = &self.word[id * hidden..(id + 1) * hidden];
            let position = &self.position[t * hidden..(t + 1) * hidden];
            for (i, value) in row.iter_mut().enumerate() {
                *value = word[i] + position[i] + self.segment[i];
            }
        }
        layer_norm(&self.embedding_norm, &mut x);

        let inner = self.layers[0].intermediate.out_dim;
        let mut q = vec![0.0_f32; n * hidden];
        let mut k = vec![0.0_f32; n * hidden];
        let mut v = vec![0.0_f32; n * hidden];
        let mut context = vec![0.0_f32; n * hidden];
        let mut attended = vec![0.0_f32; n * hidden];
        let mut wide = vec![0.0_f32; n * inner];
        let mut narrow = vec![0.0_f32; n * hidden];
        let mut scores = vec![0.0_f32; n];
        for layer in &self.layers {
            dense(&layer.query, &x, &mut q);
            dense(&layer.key, &x, &mut k);
            dense(&layer.value, &x, &mut v);
            self.attend(n, &q, &k, &v, &mut context, &mut scores);
            dense(&layer.attention_out, &context, &mut attended);
            for (value, add) in x.iter_mut().zip(&attended) {
                *value += add;
            }
            layer_norm(&layer.attention_norm, &mut x);

            dense(&layer.intermediate, &x, &mut wide);
            gelu(&mut wide);
            dense(&layer.output, &wide, &mut narrow);
            for (value, add) in x.iter_mut().zip(&narrow) {
                *value += add;
            }
            layer_norm(&layer.output_norm, &mut x);
        }

        let mut pooled = vec![0.0_f32; hidden];
        let pooled_rows = match self.pooling {
            Pooling::Mean => &x[..],
            Pooling::First => &x[..hidden],
        };
        for row in pooled_rows.chunks_exact(hidden) {
            for (total, value) in pooled.iter_mut().zip(row) {
                *total += value;
            }
        }
        let length = pooled.iter().map(|v| v * v).sum::<f32>().sqrt().max(EPS);
        for value in &mut pooled {
            *value /= length;
        }
        pooled
    }
}

/// Scores every row of `vectors` against `query`. With vectors of length 1, each score is
/// the cosine similarity. Lives here so it runs optimized in debug builds too.
pub fn score_all(query: &[f32], vectors: &[f32], scores: &mut Vec<f32>) {
    scores.clear();
    let dim = query.len();
    if dim == 0 {
        return;
    }
    scores.reserve(vectors.len() / dim);
    for row in vectors.chunks_exact(dim) {
        scores.push(dot(query, row));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32, within: f32) -> bool {
        (a - b).abs() <= within
    }

    #[test]
    fn exp_matches_the_standard_library() {
        for x in [-80.0_f32, -20.0, -1.5, -0.1, 0.0, 0.1, 1.0, 5.5, 40.0] {
            let want = x.exp();
            assert!(close(exp_one(x), want, want * 3e-6), "{x}: {} against {want}", exp_one(x));
        }
    }

    #[test]
    fn gelu_matches_known_values() {
        // torch.nn.functional.gelu at these points.
        let mut values = [-3.0_f32, -1.0, 0.0, 0.5, 1.0, 3.0];
        gelu(&mut values);
        let want = [-0.004_049_7, -0.158_655_3, 0.0, 0.345_731_2, 0.841_344_7, 2.995_950_2];
        for (got, want) in values.iter().zip(want) {
            assert!(close(*got, want, 2e-6), "{got} against {want}");
        }
    }

    #[test]
    fn the_fast_and_plain_kernels_agree() {
        let in_dim = 13;
        let out_dim = 19;
        let columns: Vec<f32> = (0..in_dim * out_dim).map(|i| ((i * 37 % 101) as f32 - 50.0) / 50.0).collect();
        let bias: Vec<f32> = (0..out_dim).map(|i| i as f32 / 10.0).collect();
        let layer = Dense { columns: columns.clone(), bias: bias.clone(), in_dim, out_dim };
        let x: Vec<f32> = (0..in_dim * 3).map(|i| (i as f32 * 0.7).sin()).collect();
        let mut fast = vec![0.0; out_dim * 3];
        dense(&layer, &x, &mut fast);
        for t in 0..3 {
            for o in 0..out_dim {
                let plain: f32 = bias[o] + (0..in_dim).map(|j| x[t * in_dim + j] * columns[j * out_dim + o]).sum::<f32>();
                assert!(close(fast[t * out_dim + o], plain, 1e-4));
            }
        }
        let a: Vec<f32> = (0..37).map(|i| (i as f32).cos()).collect();
        let b: Vec<f32> = (0..37).map(|i| (i as f32 * 0.3).sin()).collect();
        let plain: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!(close(dot(&a, &b), plain, 1e-4));
    }

    #[test]
    fn scores_rank_the_closest_row_first() {
        let query = vec![1.0, 0.0];
        let rows = vec![0.0, 1.0, 1.0, 0.0, -1.0, 0.0];
        let mut scores = Vec::new();
        score_all(&query, &rows, &mut scores);
        assert_eq!(scores, vec![0.0, 1.0, -1.0]);
    }
}
