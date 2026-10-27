import { Loader2 } from "lucide-react";
import { lazy, Suspense, type ComponentType } from "react";
import { AboutDialog } from "./components/layout/AboutDialog";
import { UpdateDialog } from "./components/layout/UpdateDialog";
import { KitAssemblerDialog } from "./components/tools/KitAssemblerDialog";
import { CommandPalette } from "./components/layout/CommandPalette";
import { HeaderDashboard } from "./components/layout/HeaderDashboard";
import { LogDrawer } from "./components/layout/LogDrawer";
import { NavigationRail } from "./components/layout/NavigationRail";
import { BlenderTab } from "./components/tabs/BlenderTab";
import { DashboardTab } from "./components/tabs/DashboardTab";
import { MatcherTab } from "./components/tabs/MatcherTab";
import { FbxDoctorTab } from "./components/tabs/FbxDoctorTab";
import { RecipesTab } from "./components/tabs/RecipesTab";
import { RenamerTab } from "./components/tabs/RenamerTab";
import { ToolsTab } from "./components/tabs/ToolsTab";
import { useBackendBridge } from "./hooks/useBackendBridge";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { useWindowDragDrop } from "./hooks/useWindowDragDrop";
import { useAppStore } from "./stores/appStore";
// Registers the preview drop handler even before the (lazy) previewer has loaded.
import "./stores/previewStore";
import type { TabId } from "./types/pipeline";

// three.js is only fetched when the previewer is first opened, keeping startup light.
const PreviewTab = lazy(() => import("./components/tabs/PreviewTab").then((m) => ({ default: m.PreviewTab })));

const TABS: Record<TabId, ComponentType> = {
  renamer: RenamerTab,
  fbx: FbxDoctorTab,
  blender: BlenderTab,
  preview: PreviewTab,
  tools: ToolsTab,
  recipes: RecipesTab,
  dashboard: DashboardTab,
  matcher: MatcherTab,
};

export default function App() {
  useBackendBridge();
  useGlobalHotkeys();
  useWindowDragDrop();

  const activeTab = useAppStore((s) => s.activeTab);
  const ActiveTab = TABS[activeTab];

  return (
    <div className="flex h-full">
      <NavigationRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <HeaderDashboard />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-ink-faint">
                <Loader2 className="size-5 animate-spin" />
              </div>
            }
          >
            <ActiveTab />
          </Suspense>
        </main>
        <LogDrawer />
      </div>
      <CommandPalette />
      <AboutDialog />
      <UpdateDialog />
      <KitAssemblerDialog />
    </div>
  );
}
