import { Boxes, FileWarning, Search } from "lucide-react";
import { moduleById } from "../../lib/modules";
import { useAppStore } from "../../stores/appStore";
import { PillBadge } from "../ui/PillBadge";

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Boxes; label: string; value: number; tone: "neutral" | "rose" }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel-raised/60 px-2.5 py-1">
      <Icon className={tone === "rose" && value > 0 ? "size-3.5 text-rose" : "size-3.5 text-ink-faint"} />
      <span className="text-[12px] text-ink-muted">{label}</span>
      <PillBadge tone={tone === "rose" && value > 0 ? "rose" : "neutral"}>{value.toLocaleString()}</PillBadge>
    </div>
  );
}

export function HeaderDashboard() {
  const activeTab = useAppStore((s) => s.activeTab);
  const assetCount = useAppStore((s) => s.assetCount);
  const brokenPathCount = useAppStore((s) => s.brokenPathCount);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const appInfo = useAppStore((s) => s.appInfo);
  const mod = moduleById(activeTab);

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-edge bg-panel/70 px-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="text-[14px] font-semibold whitespace-nowrap text-ink">{mod.label}</h1>
        <span className="hidden truncate text-[12px] text-ink-faint 2xl:inline">{mod.description}</span>
      </div>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="mx-auto flex h-8 w-full max-w-sm items-center gap-2 rounded-lg border border-edge bg-canvas/70 px-3 text-left text-[12px] text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-muted"
      >
        <Search className="size-3.5" />
        <span className="flex-1">Search actions…</span>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        <Stat icon={Boxes} label="Assets" value={assetCount} tone="neutral" />
        <Stat icon={FileWarning} label="Broken paths" value={brokenPathCount} tone="rose" />
        <PillBadge tone={appInfo ? "emerald" : "amber"} className="ml-1">
          {appInfo ? `v${appInfo.version}` : "browser preview"}
        </PillBadge>
      </div>
    </header>
  );
}
