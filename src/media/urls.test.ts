import { parseWebUrl, recognizeVideoUrl, singleUrlFrom, videoSiteName } from './urls';

describe('recognizeVideoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc123', 'YouTube'],
    ['https://youtube.com/watch?v=abc123&t=30s', 'YouTube'],
    ['https://m.youtube.com/watch?v=abc123', 'YouTube'],
    ['https://youtu.be/abc123', 'YouTube'],
    ['https://www.youtube.com/shorts/abc123', 'YouTube'],
    ['https://www.youtube.com/live/abc123', 'YouTube'],
    ['https://www.youtube.com/embed/abc123', 'YouTube'],
    ['https://www.youtube-nocookie.com/embed/abc123', 'YouTube'],
    ['https://vimeo.com/76979871', 'Vimeo'],
    ['https://player.vimeo.com/video/76979871', 'Vimeo'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'Vimeo'],
    ['https://www.dailymotion.com/video/x7tgad0', 'Dailymotion'],
    ['https://dai.ly/x7tgad0', 'Dailymotion'],
    ['https://www.twitch.tv/videos/123456', 'Twitch'],
    ['https://www.twitch.tv/someone/clip/SomeClip', 'Twitch'],
    ['https://www.tiktok.com/@someone/video/123', 'TikTok'],
  ])('knows %s', (url, site) => {
    expect(recognizeVideoUrl(url)).toEqual({ url, site });
  });

  it.each([
    'https://example.com/clips/storm.mp4',
    'http://example.com/storm.webm',
    'https://cdn.example.com/a/b/storm.MOV?token=abc',
    'https://example.com/storm.ogv#t=10',
    'https://example.com/live/stream.m3u8',
  ])('knows a plain link to a video file: %s', (url) => {
    expect(recognizeVideoUrl(url)?.site).toBeNull();
    expect(recognizeVideoUrl(url)?.url).toBe(url);
  });

  it.each([
    // Not videos, though on video sites.
    'https://www.youtube.com/',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/results?search_query=storm',
    'https://www.youtube.com/watch',
    'https://vimeo.com/about',
    'https://www.twitch.tv/someone',
    // Other sites and things.
    'https://example.com/an-article',
    'https://example.com/picture.png',
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.evil.example/watch?v=abc',
    'not a url at all',
    'youtube.com/watch?v=abc',
    '',
    // Only web addresses, and only one.
    'javascript:alert(1)//.mp4',
    'file:///C:/clips/storm.mp4',
    'ftp://example.com/storm.mp4',
    'https://example.com/a.mp4 https://example.com/b.mp4',
    // A password has no business being stored in a document.
    'https://user:secret@example.com/storm.mp4',
  ])('does not take %s', (text) => {
    expect(recognizeVideoUrl(text)).toBeNull();
  });

  it('trims what it is given', () => {
    expect(recognizeVideoUrl('  https://youtu.be/abc\n')?.url).toBe('https://youtu.be/abc');
  });
});

describe('parseWebUrl and videoSiteName', () => {
  it('accepts any web address, as the Video link command does', () => {
    expect(parseWebUrl('https://example.com/a-page')?.href).toBe('https://example.com/a-page');
    expect(parseWebUrl('http://example.com')?.hostname).toBe('example.com');
    expect(parseWebUrl('https://')).toBeNull();
    expect(parseWebUrl('mailto:a@b.c')).toBeNull();
    expect(parseWebUrl('two words')).toBeNull();
  });

  it('names known sites, for the card', () => {
    expect(videoSiteName(new URL('https://www.youtube.com/watch?v=x'))).toBe('YouTube');
    expect(videoSiteName(new URL('https://example.com/x.mp4'))).toBeNull();
  });
});

describe('singleUrlFrom', () => {
  const carrier = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });

  it('prefers the address list and skips its comments', () => {
    expect(singleUrlFrom(carrier({ 'text/uri-list': '# from a browser\r\nhttps://a.example/x\r\n', 'text/plain': 'Some title' }))).toBe('https://a.example/x');
  });

  it('falls back to plain text of one word', () => {
    expect(singleUrlFrom(carrier({ 'text/plain': ' https://a.example/x ' }))).toBe('https://a.example/x');
    expect(singleUrlFrom(carrier({ 'text/plain': 'two words' }))).toBeNull();
    expect(singleUrlFrom(carrier({}))).toBeNull();
  });

  it('does not choose between several', () => {
    expect(singleUrlFrom(carrier({ 'text/uri-list': 'https://a.example/x\nhttps://a.example/y' }))).toBeNull();
  });
});
