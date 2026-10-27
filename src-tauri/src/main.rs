// Release builds run without a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if poseidon_lib::cli::wants_cli(&args) {
        std::process::exit(poseidon_lib::cli::run(&args));
    }
    poseidon_lib::run()
}
