//! Headless command line: `poseidon --recipe <recipe.json> <folder> [--dry-run] [--report <out.json>] [--blender <exe>]`.
//! Runs a recipe without opening a window, for build scripts and CI. Exit code 0 when every step succeeded.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::core::blender_runner::{best_blender, blend_dependencies};
use crate::core::recipe::{run_recipe, Recipe, RecipeEnv};

const USAGE: &str = "Usage: poseidon --recipe <recipe.json> <folder> [--dry-run] [--report <out.json>] [--blender <blender.exe>]";
const SCRIPT: &str = "dcc_scripts/blender/headless_pack.py";

#[derive(Debug)]
pub struct CliArgs {
    pub recipe: PathBuf,
    pub folder: PathBuf,
    pub dry_run: bool,
    pub report: Option<PathBuf>,
    pub blender: Option<PathBuf>,
}

/// True when the process was started for the command line rather than the app window.
pub fn wants_cli(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--recipe" || a == "--help" || a == "-h")
}

pub fn parse_args(args: &[String]) -> Result<CliArgs, String> {
    let mut recipe = None;
    let mut folder = None;
    let (mut dry_run, mut report, mut blender) = (false, None, None);
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let mut value = |flag: &str| it.next().cloned().ok_or(format!("{flag} needs a value"));
        match a.as_str() {
            "--recipe" => recipe = Some(PathBuf::from(value("--recipe")?)),
            "--report" => report = Some(PathBuf::from(value("--report")?)),
            "--blender" => blender = Some(PathBuf::from(value("--blender")?)),
            "--dry-run" => dry_run = true,
            "--help" | "-h" => return Err(USAGE.into()),
            f if f.starts_with("--") => return Err(format!("Unknown option {f}\n{USAGE}")),
            other if folder.is_none() => folder = Some(PathBuf::from(other)),
            other => return Err(format!("Unexpected argument {other}\n{USAGE}")),
        }
    }
    Ok(CliArgs { recipe: recipe.ok_or(USAGE)?, folder: folder.ok_or(USAGE)?, dry_run, report, blender })
}

/// The pack script next to the installed executable, or in the source tree during development.
fn script_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(SCRIPT);
    [exe_dir.join(SCRIPT), dev].into_iter().find(|p| p.is_file())
}

/// Release builds use the Windows GUI subsystem: borrow the calling terminal's console for output.
fn attach_console() {
    #[cfg(windows)]
    {
        extern "system" {
            fn AttachConsole(process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

pub fn run(args: &[String]) -> i32 {
    attach_console();
    let cli = match parse_args(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let recipe = match Recipe::load(&cli.recipe) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    if !cli.folder.is_dir() {
        eprintln!("Folder not found: {}", cli.folder.display());
        return 2;
    }

    let blender = cli.blender.clone().or_else(|| best_blender().map(|b| b.executable));
    let reader = blender.zip(script_path()).map(|(b, s)| move |p: &Path| blend_dependencies(&b, &s, p, Duration::from_secs(300)));
    let mut on_step = |i: usize, n: usize, title: &str| println!("[{}/{n}] {title}…", i + 1);
    let mut env = RecipeEnv { blend_reader: None, on_step: &mut on_step };
    if let Some(r) = &reader {
        env.blend_reader = Some(r);
    }

    let mode = if cli.dry_run { " (dry run: nothing is changed)" } else { "" };
    println!("Poseidon {} — recipe \"{}\" on {}{mode}", env!("CARGO_PKG_VERSION"), recipe.name, cli.folder.display());
    let result = run_recipe(&recipe, &cli.folder, cli.dry_run, &mut env);
    for s in &result.steps {
        let mark = match (s.ok, s.skipped, s.problems) {
            (true, _, 0) => "OK  ",
            (true, _, _) => "WARN",
            (_, true, _) => "SKIP",
            _ => "FAIL",
        };
        println!("{mark} {}: {}", s.title, s.summary);
        // Problem lines first: they are what needs attention.
        let mut details: Vec<&String> = s.details.iter().filter(|d| d.trim_start().starts_with('!')).collect();
        details.extend(s.details.iter().filter(|d| !d.trim_start().starts_with('!')));
        for d in details.into_iter().take(20) {
            println!("       {d}");
        }
        if s.details.len() > 20 {
            println!("       … {} more line(s) in the report", s.details.len() - 20);
        }
    }
    println!("{} in {} ms", if result.ok { "Finished" } else { "Stopped after a failed step" }, result.elapsed_ms);

    if let Some(path) = &cli.report {
        let json = serde_json::to_string_pretty(&result).expect("run serializes");
        if let Err(e) = std::fs::write(path, json) {
            eprintln!("Cannot write report {}: {e}", path.display());
            return 1;
        }
        println!("Report written to {}", path.display());
    }
    if result.ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("poseidon").chain(list.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn parses_flags() {
        assert!(!wants_cli(&args(&[])));
        assert!(wants_cli(&args(&["--recipe", "r.json", "D:/a"])));
        let c = parse_args(&args(&["--recipe", "r.json", "D:/a", "--dry-run", "--report", "out.json"])).unwrap();
        assert_eq!((c.recipe, c.folder, c.dry_run, c.report), (PathBuf::from("r.json"), PathBuf::from("D:/a"), true, Some(PathBuf::from("out.json"))));
        assert!(parse_args(&args(&["--recipe", "r.json"])).is_err(), "folder required");
        assert!(parse_args(&args(&["--recipe"])).unwrap_err().contains("needs a value"));
        assert!(parse_args(&args(&["--recipe", "r.json", "a", "b"])).is_err());
        assert!(parse_args(&args(&["--bogus"])).unwrap_err().contains("Unknown option"));
    }

    #[test]
    fn runs_a_recipe_file() {
        let dir = tempfile::tempdir().unwrap();
        let recipe = dir.path().join("r.json");
        std::fs::write(&recipe, r#"{"name":"audit","steps":[{"kind":"inspectMeshes"},{"kind":"findDuplicates"}]}"#).unwrap();
        std::fs::write(dir.path().join("a.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1 2 3\n").unwrap();
        let report = dir.path().join("out.json");
        let code = run(&args(&["--recipe", &recipe.to_string_lossy(), &dir.path().to_string_lossy(), "--report", &report.to_string_lossy()]));
        assert_eq!(code, 0);
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
        assert_eq!(json["steps"][0]["kind"], "inspectMeshes");
        assert!(json["steps"][0]["summary"].as_str().unwrap().starts_with("1 mesh file(s), 1 triangles"));
        assert_eq!(run(&args(&["--recipe", "missing.json", "."])), 2);
    }
}
