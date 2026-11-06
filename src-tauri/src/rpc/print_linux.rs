//! PDFs on Linux, through WebKitGTK's own print operation. GTK's file printer writes the
//! PDF to a temporary file, with no dialog, on the paper from the page's @page rule.

use std::path::Path;
use std::sync::mpsc::Sender;

use webkit2gtk::{PrintOperation, PrintOperationExt};

use super::print::Sheet;

/// Starts printing `webview` to `out`. Must run on the GTK main thread; `done` hears once
/// the file is written or the print failed.
pub fn print(webview: &webkit2gtk::WebView, sheet: &Sheet, out: &Path, done: Sender<Result<(), String>>) {
    let uri = match gtk::glib::filename_to_uri(out, None) {
        Ok(uri) => uri,
        Err(e) => {
            let _ = done.send(Err(e.to_string()));
            return;
        }
    };
    let paper = gtk::PaperSize::new_custom("lorecraft", "LoreCraft", sheet.width, sheet.height, gtk::Unit::Points);

    let settings = gtk::PrintSettings::new();
    // GTK's file backend names its printer this way in every language.
    settings.set_printer("Print to File");
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
    settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
    settings.set_paper_size(&paper);
    settings.set_orientation(gtk::PageOrientation::Portrait);

    let setup = gtk::PageSetup::new();
    setup.set_paper_size(&paper);
    setup.set_orientation(gtk::PageOrientation::Portrait);
    let [top, right, bottom, left] = sheet.margins;
    setup.set_top_margin(top, gtk::Unit::Points);
    setup.set_right_margin(right, gtk::Unit::Points);
    setup.set_bottom_margin(bottom, gtk::Unit::Points);
    setup.set_left_margin(left, gtk::Unit::Points);

    let operation = PrintOperation::new(webview);
    operation.set_print_settings(&settings);
    operation.set_page_setup(&setup);
    // "failed" comes before "finished", so whichever arrives first is the answer.
    let failed = done.clone();
    operation.connect_failed(move |_, error| {
        let _ = failed.send(Err(error.to_string()));
    });
    // WebKit keeps the operation alive until the job ends.
    operation.connect_finished(move |_| {
        let _ = done.send(Ok(()));
    });
    operation.print();
}
