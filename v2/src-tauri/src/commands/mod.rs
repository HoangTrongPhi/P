//! Tauri IPC handlers. Each submodule wraps one `core` engine; handlers stay thin and run
//! blocking work on the async runtime's blocking pool.

pub mod app_cmd;
pub mod blender_cmd;
pub mod fbx_cmd;
pub mod renamer_cmd;
pub mod scanner_cmd;

/// The JSON the frontend sends (see `src/types/pipeline.ts`) must decode into the command inputs.
#[cfg(test)]
mod contract_tests {
    use super::blender_cmd::BlenderPackConfig;
    use super::fbx_cmd::FbxFixPlan;
    use super::renamer_cmd::{RenameAction, RenameConfig};
    use crate::core::fbx::FixMode;
    use crate::core::renamer::{CaseStyle, Preset, RuleSpec};
    use serde_json::json;

    #[test]
    fn rename_config_from_ts() {
        let cfg: RenameConfig = serde_json::from_value(json!({
            "rules": [
                { "kind": "searchReplace", "find": r"(\d+)", "replace": "_${1}", "regex": true },
                { "kind": "prefix", "prefix": "T_" },
                { "kind": "suffix", "suffix": "_v2", "skipIfPresent": false },
                { "kind": "case", "style": "pascal" },
                { "kind": "preset", "preset": "ue5" }
            ],
            "recursive": true,
            "extensions": ["png"]
        }))
        .unwrap();
        assert!(cfg.recursive && cfg.paths.is_none());
        assert!(matches!(&cfg.rules[0], RuleSpec::SearchReplace { regex: true, case_sensitive: true, .. }));
        assert!(matches!(&cfg.rules[1], RuleSpec::Prefix { skip_if_present: true, .. }));
        assert!(matches!(&cfg.rules[2], RuleSpec::Suffix { skip_if_present: false, .. }));
        assert!(matches!(&cfg.rules[3], RuleSpec::Case { style: CaseStyle::Pascal }));
        assert!(matches!(&cfg.rules[4], RuleSpec::Preset { preset: Preset::Ue5 }));

        let a: RenameAction = serde_json::from_value(json!({ "originalPath": "a", "targetPath": "b" })).unwrap();
        assert_eq!((a.original_path.as_str(), a.target_path.as_str()), ("a", "b"));
    }

    #[test]
    fn fbx_fix_plan_from_ts() {
        let plan: FbxFixPlan = serde_json::from_value(json!({ "paths": ["C:/x"], "mode": "collect", "subfolder": "tex", "dryRun": true })).unwrap();
        assert_eq!(plan.options.mode, FixMode::Collect);
        assert_eq!(plan.options.subfolder, "tex");
        assert!(plan.options.dry_run && plan.options.backup && !plan.options.fix_all);

        let minimal: FbxFixPlan = serde_json::from_value(json!({ "paths": [] })).unwrap();
        assert_eq!(minimal.options.mode, FixMode::Relative);
        assert_eq!(minimal.options.subfolder, "textures");
    }

    #[test]
    fn blender_config_from_ts() {
        let cfg: BlenderPackConfig = serde_json::from_value(json!({
            "blendFile": "C:/a.blend",
            "options": { "packAll": true, "zipArchive": "C:/a.zip", "output": null }
        }))
        .unwrap();
        assert!(cfg.blender_path.is_none());
        assert!(cfg.options.pack_all && cfg.options.consolidate && cfg.options.make_relative);
        assert!(cfg.options.zip_archive.is_some() && cfg.options.output.is_none());
    }
}
