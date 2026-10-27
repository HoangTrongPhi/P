// Release builds run without a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if project_p_lib::cli::wants_cli(&args) {
        std::process::exit(project_p_lib::cli::run(&args));
    }
    project_p_lib::run()
}
