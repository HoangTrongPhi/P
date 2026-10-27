/** Report documents for each analysis result (see `reports.ts` for the HTML / CSV writers). */
import type { ConvertItem, DuplicateReport, FbxFileInfo, MapKind, MeshStats, RecipeRun, TextureSetReport, UnusedReport } from "../types/pipeline";
import { basename, humanSize } from "./pathUtil";
import { relPath, type ReportDoc } from "./reports";

export const MAP_LABELS: Record<MapKind, string> = {
  baseColor: "Base color",
  normal: "Normal",
  orm: "ORM",
  roughness: "Roughness",
  gloss: "Gloss",
  metallic: "Metallic",
  ao: "AO",
  emissive: "Emissive",
  height: "Height",
  opacity: "Opacity",
  specular: "Specular",
};

const fmt = (n: number) => n.toLocaleString("en-US");

export function duplicatesReport(d: DuplicateReport, folder: string | null): ReportDoc {
  return {
    title: "Duplicate assets",
    subject: folder ?? undefined,
    summary: [
      ["Groups", d.groups.length],
      ["Reclaimable", humanSize(d.wastedBytes)],
      ["Assets scanned", d.scannedFiles],
    ],
    sections: [
      {
        columns: ["Group", "Hash (XXH3-128)", "Size", "File"],
        rows: d.groups.flatMap((g, i) => g.files.map((f) => [i + 1, g.hash, g.size, relPath(f, folder)])),
      },
    ],
  };
}

export function unusedReport(u: UnusedReport, folder: string | null): ReportDoc {
  return {
    title: "Unused textures",
    subject: folder ?? undefined,
    summary: [
      ["Unreferenced", `${u.textures.length} of ${u.totalTextures}`],
      ["Reclaimable", humanSize(u.reclaimableBytes)],
      ["Reference files read", u.referenceFiles],
      [".blend files read", `${u.blendInspected} of ${u.blendFiles}`],
    ],
    sections: [
      { columns: ["Texture", "Size (bytes)"], rows: u.textures.map((t) => [relPath(t.path, folder), t.size]) },
      ...(u.warnings.length ? [{ heading: "Files that could not be read", columns: ["Warning"], rows: u.warnings.map((w) => [w]) }] : []),
    ],
  };
}

export function textureSetsReport(r: TextureSetReport, folder: string | null): ReportDoc {
  const kinds = Object.keys(MAP_LABELS) as MapKind[];
  const used = kinds.filter((k) => r.sets.some((s) => s.maps[k]));
  return {
    title: "Texture sets",
    subject: folder ?? undefined,
    summary: [
      ["Sets", r.sets.length],
      ["Incomplete", r.sets.filter((s) => s.missing.length).length],
      ["Ready for ORM", r.sets.filter((s) => s.canPackOrm).length],
      ["Unmatched textures", r.unmatched.length],
    ],
    sections: [
      {
        columns: ["Folder", "Set", ...used.map((k) => MAP_LABELS[k]), "Missing"],
        rows: r.sets.map((s) => [relPath(s.dir, folder) || ".", s.name, ...used.map((k) => (s.maps[k] ? basename(s.maps[k]!) : "")), s.missing.map((k) => MAP_LABELS[k]).join(", ")]),
      },
      ...(r.unmatched.length ? [{ heading: "Textures without a map suffix", columns: ["Texture"], rows: r.unmatched.map((p) => [relPath(p, folder)]) }] : []),
    ],
  };
}

export function meshesReport(stats: MeshStats[], folder: string | null): ReportDoc {
  const tris = stats.reduce((n, s) => n + s.triangles, 0);
  const size = (s: MeshStats) => (s.bounds ? s.bounds.max.map((v, i) => (v - s.bounds!.min[i]).toFixed(2)).join(" x ") : "");
  return {
    title: "Mesh inspection",
    subject: folder ?? undefined,
    summary: [
      ["Files", stats.length],
      ["Triangles", fmt(tris)],
      ["With warnings", stats.filter((s) => s.warnings.length || s.error).length],
    ],
    sections: [
      {
        columns: ["File", "Format", "Meshes", "Vertices", "Triangles", "Materials", "UV sets", "Normals", "Size (units)", "cm / unit", "Up", "Warnings"],
        rows: stats.map((s) => [
          relPath(s.path, folder),
          s.format,
          s.meshes,
          s.vertices,
          s.triangles,
          s.materials,
          s.uvSets,
          s.hasNormals,
          size(s),
          s.unitScaleCm,
          s.upAxis,
          s.error ?? s.warnings.join("; "),
        ]),
      },
    ],
  };
}

export function convertReport(items: ConvertItem[]): ReportDoc {
  const dim = (d: [number, number] | null) => (d ? `${d[0]}x${d[1]}` : "");
  return {
    title: "Texture conversion",
    summary: [
      ["Converted", items.filter((i) => i.written).length],
      ["Skipped", items.filter((i) => i.skipped).length],
      ["Failed", items.filter((i) => i.error).length],
    ],
    sections: [
      {
        columns: ["Source", "Output", "From", "To", "Bytes before", "Bytes after", "Status"],
        rows: items.map((i) => [i.source, i.output, dim(i.fromSize), dim(i.toSize), i.bytesBefore, i.bytesAfter, i.error ?? i.skipped ?? (i.written ? "written" : "dry run")]),
      },
    ],
  };
}

export function fbxReport(files: FbxFileInfo[], sources: string[]): ReportDoc {
  return {
    title: "FBX texture paths",
    subject: sources.join(", "),
    summary: [
      ["FBX files", files.length],
      ["With issues", files.filter((f) => f.hasIssues).length],
      ["Problem paths", files.reduce((n, f) => n + f.problemCount, 0)],
    ],
    sections: [
      {
        columns: ["FBX", "Format", "Owner", "Field", "Path", "Kind", "Resolution", "Resolved to"],
        rows: files.flatMap((f) =>
          f.error
            ? [[f.path, "unreadable", "", "", f.error, "", "", ""]]
            : f.entries.map((e) => [f.path, `${f.isBinary ? "binary" : "ASCII"} ${f.version}`, e.nodeName, e.propertyName, e.originalPath, e.kind, e.resolution, e.resolvedPath]),
        ),
      },
    ],
  };
}

export function recipeRunReport(run: RecipeRun): ReportDoc {
  return {
    title: `Recipe: ${run.name || "untitled"}${run.dryRun ? " (dry run)" : ""}`,
    subject: run.folder,
    summary: [
      ["Result", run.ok ? "OK" : "Stopped after a failed step"],
      ["Steps", run.steps.length],
      ["Time", `${fmt(run.elapsedMs)} ms`],
    ],
    sections: [
      {
        heading: "Steps",
        columns: ["#", "Step", "Status", "Summary", "Time (ms)"],
        rows: run.steps.map((s, i) => [i + 1, s.title, s.ok ? "OK" : s.skipped ? "Not run" : "Failed", s.summary, s.elapsedMs]),
      },
      ...run.steps.filter((s) => s.details.length).map((s) => ({ heading: s.title, columns: ["Detail"], rows: s.details.map((d) => [d]) })),
    ],
  };
}
