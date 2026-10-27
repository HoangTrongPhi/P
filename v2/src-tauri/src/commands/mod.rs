//! Tauri IPC handlers. Each submodule wraps one `core` engine; handlers stay thin and run
//! blocking work on the async runtime's blocking pool.

pub mod app_cmd;
pub mod blender_cmd;
pub mod fbx_cmd;
pub mod kit_cmd;
pub mod preview_cmd;
pub mod recipe_cmd;
pub mod renamer_cmd;
pub mod scanner_cmd;
pub mod tools_cmd;

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
        assert!(plan.options.search_parent && !plan.options.guess_missing, "safe defaults");

        let minimal: FbxFixPlan = serde_json::from_value(json!({ "paths": [] })).unwrap();
        assert_eq!(minimal.options.mode, FixMode::Relative);
        assert_eq!(minimal.options.subfolder, "textures");
    }

    #[test]
    fn asset_manifest_and_kit_options_from_ts() {
        use crate::core::kit_assembler::{AssetManifest, KitOptions, Naming};
        use crate::core::texture_sets::MapKind;
        // As written by `buildManifest` in `src/stores/matcherStore.ts`; extra fields are ignored.
        let m: AssetManifest = serde_json::from_value(json!({
            "format": "project-p.asset-manifest", "version": 1, "root": "G:/Drive/Wall", "generated": "2026-10-27T00:00:00Z",
            "assets": [{
                "mesh": "Meshes/SM_A.fbx",
                "slots": [
                    { "slot": "M_A", "isMaterial": true, "confidence": 93, "status": "likely", "decision": "auto",
                      "textureSet": { "name": "A", "folder": "Textures", "maps": { "baseColor": "Textures/A_D.png", "orm": "Textures/A_ORM.png" }, "missingMaps": [] } },
                    { "slot": "M_B", "isMaterial": true, "confidence": null, "status": "none", "decision": "open", "textureSet": null }
                ],
                "missingReferences": [], "error": null
            }],
            "unassignedTextureSets": [], "looseTextures": []
        }))
        .unwrap();
        let set = m.assets[0].slots[0].texture_set.as_ref().unwrap();
        assert_eq!(set.maps.keys().copied().collect::<Vec<_>>(), [MapKind::BaseColor, MapKind::Orm]);
        assert!(m.assets[0].slots[1].texture_set.is_none());

        let o: KitOptions = serde_json::from_value(json!({ "dest": "D:/Kit" })).unwrap();
        assert_eq!((o.naming, o.mesh_dir.as_str(), o.texture_dir.as_str()), (Naming::Ue5, "Meshes", "Textures"));
        assert!(o.pack_orm && o.relink && !o.overwrite && !o.dry_run && !o.include_open && !o.keep_packages);
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
