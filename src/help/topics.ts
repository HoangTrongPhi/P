import type { HelpBlock, HelpSection, HelpTopic } from "./types";

/*
 * Poseidon's Help content, Vietnamese + English. One topic per tab (topic id = TabId, so the
 * panel opens on the current tab) plus "Getting started". Labels in **bold** match the UI
 * exactly (the UI is in English); keep them in sync when a label changes in the code.
 */

type Pair = [vi: string, en: string];

const p = (vi: string, en: string): HelpBlock => ({ kind: "p", text: { vi, en } });
const steps = (...items: Pair[]): HelpBlock => ({ kind: "steps", items: items.map(([vi, en]) => ({ vi, en })) });
const tips = (...items: Pair[]): HelpBlock => ({ kind: "tips", items: items.map(([vi, en]) => ({ vi, en })) });
const keys = (...items: [keys: string, vi: string, en: string][]): HelpBlock => ({ kind: "keys", items: items.map(([k, vi, en]) => ({ keys: k, label: { vi, en } })) });
const section = (vi: string, en: string, ...blocks: HelpBlock[]): HelpSection => ({ heading: { vi, en }, blocks });

/** Id of the overview topic (not a tab). */
export const START_TOPIC_ID = "getting-started";

// ---------------------------------------------------------------- getting started

const gettingStarted: HelpTopic = {
  id: START_TOPIC_ID,
  title: { vi: "Bắt đầu", en: "Getting started" },
  summary: {
    vi: "Poseidon là gì, bố cục giao diện, kéo & thả, phím tắt, Command Palette, log và giao diện sáng / tối.",
    en: "What Poseidon is, the layout, drag & drop, shortcuts, the command palette, the log and appearance.",
  },
  sections: [
    section(
      "Poseidon là gì?",
      "What is Poseidon?",
      p(
        "Poseidon là bộ công cụ desktop giúp artist 3D, Technical Director và game developer **dọn dẹp, kiểm tra và đóng gói asset** trước khi đưa vào Unreal Engine 5 hoặc Unity: đổi tên hàng loạt, sửa đường dẫn texture trong FBX, gom texture của file .blend, xem mesh / texture, pack ORM, đổi định dạng texture, tìm file trùng hoặc không dùng, ghép mesh với texture và lắp thành bộ kit.",
        "Poseidon is a desktop toolkit that helps 3D artists, technical directors and game developers **clean up, check and package assets** before they go into Unreal Engine 5 or Unity: batch renaming, fixing texture paths inside FBX, consolidating .blend textures, previewing meshes and textures, ORM packing, texture conversion, finding duplicate or unused files, matching meshes to textures and assembling a clean kit.",
      ),
      tips(
        ["Hầu hết thao tác ghi file đều có bước xem trước (**Preview** / **Dry run**), bản sao lưu `.fbx.bak` hoặc **Undo**. Các công cụ tìm file trùng / không dùng chỉ báo cáo, không xoá gì.", "Most writing operations have a preview step (**Preview** / **Dry run**), a `.fbx.bak` backup or **Undo**. The duplicate / unused finders only report; they never delete."],
        ["Giao diện ứng dụng bằng tiếng Anh; hướng dẫn này in **đậm** đúng tên nút / tuỳ chọn như trên màn hình.", "The app's interface is in English; this guide shows button and option names in **bold** exactly as on screen."],
      ),
    ),
    section(
      "Bố cục giao diện",
      "Layout",
      tips(
        ["**Thanh điều hướng (cột trái)**: 8 công cụ theo thứ tự Ctrl+1 … Ctrl+8. Phía dưới: **Appearance** (bánh răng), **About & contact**, **Command palette** và nút bật / tắt log.", "**Navigation rail (left)**: the 8 tools, in the order of Ctrl+1 … Ctrl+8. At the bottom: **Appearance** (gear), **About & contact**, **Command palette** and the log toggle."],
        ["**Header**: tên công cụ đang mở, ô **Search actions…** (mở Command Palette), bộ đếm **Assets** và **Broken paths** (số đường dẫn texture lỗi do FBX Doctor tìm thấy), nút **?** mở hướng dẫn này, và nhãn phiên bản (bấm để kiểm tra bản cập nhật).", "**Header**: the current tool, the **Search actions…** box (opens the command palette), the **Assets** and **Broken paths** counters (broken texture paths found by FBX Doctor), the **?** button for this guide, and the version pill (click it to check for updates)."],
        ["**Log (dưới đáy)**: nhật ký hoạt động của ứng dụng và phần xử lý Rust, kể cả output của Blender.", "**Log (bottom)**: activity from the app and the Rust backend, including Blender's output."],
      ),
    ),
    section(
      "Mở file và thư mục",
      "Opening files and folders",
      tips(
        ["**Kéo & thả** file hoặc thư mục vào bất kỳ đâu trên cửa sổ: chúng được nạp vào công cụ đang mở.", "**Drag & drop** files or folders anywhere on the window: they load into the tool that is open."],
        ["Ngoại lệ: thả **một** file `.blend` sẽ chuyển sang Blender Packer; thả một mesh / texture khi đang ở Batch Renamer (hoặc một file không phải FBX khi ở FBX Doctor) sẽ mở nó trong Asset Previewer.", "Exceptions: dropping a **single** `.blend` file switches to Blender Packer; dropping one mesh / texture while in Batch Renamer (or a non-FBX file while in FBX Doctor) opens it in Asset Previewer."],
        ["Mỗi tab có nút mở riêng (**Open folder**, **Files**, **Choose…**…). Ctrl+K → **Open folder…** / **Open files…** cũng đưa kết quả tới tab đang mở.", "Each tab has its own open buttons (**Open folder**, **Files**, **Choose…**…). Ctrl+K → **Open folder…** / **Open files…** also sends the result to the current tab."],
        ["Dashboard và Asset Matcher có nút **Choose…** kèm menu ☁: các ổ Google Drive for desktop (**My Drive**, **Shared drives**) hoặc dán đường dẫn thư mục. Link Google Drive trên web không mở trực tiếp được — menu sẽ hướng dẫn mở qua Drive for desktop. Liệt kê thư mục không tải file nào về.", "Dashboard and Asset Matcher have **Choose…** plus a ☁ menu: Google Drive for desktop drives (**My Drive**, **Shared drives**) or a pasted folder path. A Drive web link can't be opened directly; the menu explains how to reach it through Drive for desktop. Listing folders downloads nothing."],
      ),
    ),
    section(
      "Phím tắt",
      "Keyboard shortcuts",
      keys(
        ["F1", "Mở / đóng hướng dẫn này (mở đúng chủ đề của tab hiện tại)", "Open / close this guide (on the current tab's topic)"],
        ["Ctrl+K / Ctrl+P", "Command Palette", "Command palette"],
        ["Ctrl+1 … Ctrl+8", "Chuyển công cụ theo thứ tự trên thanh điều hướng", "Switch tool, in navigation-rail order"],
        ["Ctrl+`", "Hiện / ẩn log", "Show / hide the log"],
        ["Ctrl+,", "Appearance: theme, font, cỡ giao diện", "Appearance: theme, fonts, interface size"],
        ["Esc", "Đóng hộp thoại / Command Palette", "Close a dialog / the command palette"],
      ),
    ),
    section(
      "Command Palette",
      "Command palette",
      p(
        "Bấm Ctrl+K (hoặc ô **Search actions…**) rồi gõ để lọc lệnh, ↑ / ↓ để chọn, Enter để chạy, Esc để đóng.",
        "Press Ctrl+K (or click **Search actions…**), type to filter, ↑ / ↓ to choose, Enter to run, Esc to close.",
      ),
      tips(
        ["Lệnh có sẵn: **Go to …** (từng công cụ), **Open folder…**, **Open files…**, **Toggle log drawer**, **Assemble kit from manifest…**, **Appearance settings…**, **Toggle light / dark theme**, **About & contact**, **Check for updates…**, **Clear log** và **Help / Hướng dẫn**.", "Commands: **Go to …** (each tool), **Open folder…**, **Open files…**, **Toggle log drawer**, **Assemble kit from manifest…**, **Appearance settings…**, **Toggle light / dark theme**, **About & contact**, **Check for updates…**, **Clear log** and **Help / Hướng dẫn**."],
      ),
    ),
    section(
      "Log",
      "Log",
      tips(
        ["Bấm vào các nhãn mức độ (debug, info, warn, error) để ẩn / hiện từng mức; biểu tượng thùng rác xoá log.", "Click the level badges (debug, info, warn, error) to hide / show a level; the trash icon clears the log."],
        ["Kéo mép trên của log để đổi chiều cao. Log tự cuộn theo dòng mới, trừ khi bạn đang cuộn lên đọc lại.", "Drag the log's top edge to resize it. It follows new lines unless you scrolled up to read history."],
        ["Khi có lỗi, hãy xem log trước: hầu hết công cụ ghi chi tiết lý do ở đây.", "When something fails, check the log first: most tools write the details there."],
      ),
    ),
    section(
      "Giao diện và cập nhật",
      "Appearance and updates",
      tips(
        ["**Appearance** (Ctrl+, hoặc bánh răng): theme **Dark** / **Light** / **System**, **Interface font**, **Code & path font**, **Interface size** 90–125 %. **Reset** về mặc định. Thiết lập được ghi nhớ.", "**Appearance** (Ctrl+, or the gear): **Dark** / **Light** / **System** theme, **Interface font**, **Code & path font**, **Interface size** 90–125 %. **Reset** restores the defaults. Settings are remembered."],
        ["Bản cài đặt tự kiểm tra phiên bản mới trên GitHub Releases vài giây sau khi khởi động; có thể kiểm tra thủ công bằng nhãn phiên bản trên header hoặc Ctrl+K → **Check for updates…**.", "The installed app looks for a new GitHub release a few seconds after start; check manually with the header's version pill or Ctrl+K → **Check for updates…**."],
        ["Ngôn ngữ của hướng dẫn (VI / EN ở góc trên) cũng được ghi nhớ.", "The guide's language (VI / EN, top right) is remembered too."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- batch renamer

const renamer: HelpTopic = {
  id: "renamer",
  title: { vi: "Batch Renamer", en: "Batch Renamer" },
  summary: {
    vi: "Đổi tên hàng loạt mesh / texture theo chuẩn UE5, Unity hoặc quy tắc tuỳ chỉnh — xem trước từng tên mới, có Undo.",
    en: "Batch-rename meshes and textures to UE5, Unity or custom rules, with a live preview of every new name and undo.",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Thả một thư mục (hoặc vài file) vào tab, hoặc bấm **Open folder** / **Files**. Mỗi lần làm việc với một thư mục.", "Drop a folder (or some files) onto the tab, or click **Open folder** / **Files**. One folder at a time."],
        ["Chọn loại file: **All**, **Meshes** (FBX, OBJ, glTF, GLB), **Textures** hoặc **PSD**. Bật **Subfolders** để quét cả thư mục con (không áp dụng khi chọn file lẻ).", "Choose the file type: **All**, **Meshes** (FBX, OBJ, glTF, GLB), **Textures** or **PSD**. Tick **Subfolders** to include sub-folders (not available for individual files)."],
        ["Trong khung **Rules**, bấm **Add** để thêm quy tắc. Mặc định đã có preset Unreal Engine 5.", "In **Rules**, click **Add** to add a rule. An Unreal Engine 5 preset is there by default."],
        ["Bảng **Preview** cập nhật ngay khi bạn sửa quy tắc: **Current name** → **New name**, trạng thái và ghi chú.", "The **Preview** table updates as you edit rules: **Current name** → **New name**, status and note."],
        ["Bấm **Rename N files** để đổi tên các dòng OK. **Undo** hoàn tác lần đổi tên gần nhất (số trong ngoặc là số lần có thể hoàn tác).", "Click **Rename N files** to rename the OK rows. **Undo** reverts the latest rename (the number in brackets is how many can be undone)."],
      ),
    ),
    section(
      "Các loại quy tắc",
      "Rule types",
      tips(
        ["**Preset: Unreal Engine 5** — mesh thành `SM_Tên` (hoặc `SK_Tên` khi tên có gợi ý skeletal: skel, skeletal, skinned, sk), texture thành `T_Tên_D` / `_N` / `_R` / `_M` / `_ORM`.", "**Preset: Unreal Engine 5** — meshes become `SM_Name` (or `SK_Name` when the name hints at a skeletal mesh: skel, skeletal, skinned, sk), textures become `T_Name_D` / `_N` / `_R` / `_M` / `_ORM`."],
        ["**Preset: Unity** — PascalCase, texture `_Albedo` / `_Normal` / `_MaskMap`.", "**Preset: Unity** — PascalCase, textures `_Albedo` / `_Normal` / `_MaskMap`."],
        ["**Search & replace** — **Find** / **Replace**; bật **Regex** để dùng biểu thức chính quy (nhóm `$1` hoặc `${1}`); **Match case** phân biệt hoa thường.", "**Search & replace** — **Find** / **Replace**; tick **Regex** for regular expressions (groups `$1` or `${1}`); **Match case** makes it case-sensitive."],
        ["**Prefix** / **Suffix** — thêm tiền tố / hậu tố; **Skip names that already have it** bỏ qua tên đã có sẵn.", "**Prefix** / **Suffix** — add text before / after; **Skip names that already have it** leaves those names alone."],
        ["**Change case** — snake_case, camelCase, PascalCase, UPPER_CASE, lowercase, kebab-case.", "**Change case** — snake_case, camelCase, PascalCase, UPPER_CASE, lowercase, kebab-case."],
        ["Quy tắc chạy lần lượt từ trên xuống, chỉ trên phần tên (không gồm đuôi file). Ô tick ở đầu thẻ bật / tắt quy tắc; mũi tên đổi thứ tự; thùng rác xoá.", "Rules run top to bottom on the file name without its extension. The checkbox on a card enables / disables it; arrows reorder; the trash icon removes it."],
      ),
    ),
    section(
      "Trạng thái trong bảng Preview",
      "Preview statuses",
      tips(
        ["**OK** — sẽ được đổi tên. **Skipped** (đếm là unchanged) — tên đã đúng quy tắc.", "**OK** — will be renamed. **Skipped** (counted as unchanged) — the name already matches."],
        ["**Collision** — tên mới trùng với file khác. **Invalid** — tên mới không hợp lệ; xem cột **Note**.", "**Collision** — the new name clashes with another file. **Invalid** — the new name is not valid; see the **Note** column."],
        ["**Hide unchanged** (bật sẵn) ẩn các dòng không đổi. Bảng chỉ hiển thị 1 500 dòng đầu nhưng mọi file đều được đổi tên.", "**Hide unchanged** (on by default) hides unchanged rows. The table shows the first 1,500 rows, but every file is renamed."],
      ),
    ),
    section(
      "An toàn",
      "Safety",
      tips(
        ["Không có gì được ghi cho tới khi bạn bấm **Rename**. Trùng tên được kiểm tra trước, và kiểm tra lại ngay trước khi đổi (file bị từ chối được báo trong log).", "Nothing is written until you click **Rename**. Collisions are checked up front and again right before renaming (refused files are reported in the log)."],
        ["Đổi tên hai pha qua tên tạm, nên hoán đổi kiểu a → b, b → a vẫn an toàn.", "Renames go through temporary names in two phases, so swaps like a → b, b → a are safe."],
        ["Lịch sử lưu trong `.rename_history.json` ở thư mục làm việc, nên **Undo** vẫn dùng được sau khi mở lại ứng dụng. Bước **Rename assets** của Recipes cũng được hoàn tác từ tab này.", "History is kept in `.rename_history.json` in the working folder, so **Undo** still works after restarting the app. The Recipes **Rename assets** step is undone from this tab too."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- fbx doctor

const fbx: HelpTopic = {
  id: "fbx",
  title: { vi: "FBX Doctor", en: "FBX Doctor" },
  summary: {
    vi: "Tìm và sửa đường dẫn texture tuyệt đối / hỏng bên trong file FBX (Binary 7.x và ASCII) mà không cần mở phần mềm 3D.",
    en: "Find and fix absolute or broken texture paths inside FBX files (binary 7.x and ASCII) without opening a 3D app.",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Thả file FBX hoặc thư mục (quét cả thư mục con) vào tab, hoặc bấm **Open folder** / **Open FBX**.", "Drop FBX files or folders (searched recursively) onto the tab, or click **Open folder** / **Open FBX**."],
        ["Danh sách **Files**: dấu xanh = đường dẫn đã portable, vàng = có vấn đề (số đỏ là số đường dẫn lỗi), đỏ = không đọc được. Bộ đếm **Broken paths** trên header là tổng số đường dẫn lỗi.", "The **Files** list: green = portable, amber = has issues (the red number counts bad paths), red = unreadable. The header's **Broken paths** counter is the total."],
        ["Chọn một file để xem bảng: **Object / field**, **Path in file**, **Kind** (Absolute, UNC, Relative, Empty) và **On disk** (Found, By name, Missing, Embedded).", "Select a file to see its table: **Object / field**, **Path in file**, **Kind** (Absolute, UNC, Relative, Empty) and **On disk** (Found, By name, Missing, Embedded)."],
        ["Trong khung **Fix**, chọn **Mode**, các tuỳ chọn và phạm vi **All files** / **Selected file**.", "In the **Fix** panel, choose the **Mode**, options and scope **All files** / **Selected file**."],
        ["Bấm **Preview** để xem trước mọi thay đổi (đường cũ gạch ngang → đường mới), rồi bấm **Fix N files** để ghi.", "Click **Preview** to see every change (old path struck through → new path), then **Fix N files** to write."],
      ),
    ),
    section(
      "Chế độ sửa (Mode)",
      "Fix modes",
      tips(
        ["**Relative** — đường dẫn tương đối từ FBX tới nơi texture thực sự nằm. Ô **Rebase to folder (optional)** cho phép trỏ tới một thư mục cố định thay vì vị trí tìm thấy.", "**Relative** — a path from the FBX to where the texture really is. **Rebase to folder (optional)** points at a fixed folder instead of each texture's found location."],
        ["**Strip** — chỉ giữ tên file (vd. `wood.png`).", "**Strip** — keep only the file name (e.g. `wood.png`)."],
        ["**Collect** — copy texture vào thư mục con cạnh FBX (**Texture subfolder**, mặc định `textures`) và trỏ tới đó.", "**Collect** — copy the textures into a sub-folder next to the FBX (**Texture subfolder**, default `textures`) and point there."],
      ),
    ),
    section(
      "Tuỳ chọn",
      "Options",
      tips(
        ["**Extra texture folders** → **Add folder**: texture được tìm theo tên file trong các thư mục này (sâu tối đa 4 cấp), vd. một thư mục Textures bên cạnh. Kết quả tìm theo tên hiện là **By name**.", "**Extra texture folders** → **Add folder**: textures are looked up by file name in these folders (up to 4 levels deep), e.g. a sibling Textures folder. Matches found this way show as **By name**."],
        ["**Also search the parent folder** (bật sẵn): tìm cả `../Textures` cạnh thư mục chứa FBX.", "**Also search the parent folder** (on by default): also finds `../Textures` next to the FBX folder."],
        ["Phạm vi **All files** = mọi file có vấn đề (mọi file đọc được nếu bật **Rewrite every path**); **Selected file** = chỉ file đang chọn.", "Scope **All files** = every file with issues (every readable file when **Rewrite every path** is on); **Selected file** = only the selected one."],
        ["**Rewrite every path** — sửa cả đường dẫn đã hợp lệ, không chỉ đường tuyệt đối / hỏng.", "**Rewrite every path** — also rewrites valid paths, not only absolute or broken ones."],
        ["**Guess paths for missing textures** — texture không tìm thấy được gán `<subfolder>/<tên>`; tắt thì giữ nguyên đường cũ. Không dùng được với Strip.", "**Guess paths for missing textures** — unfound textures get `<subfolder>/<name>`; off keeps their current path. Not available with Strip."],
        ["**Keep .fbx.bak backup** (bật sẵn) — nên luôn bật.", "**Keep .fbx.bak backup** (on by default) — keep it on."],
      ),
    ),
    section(
      "Kết quả và an toàn",
      "Results and safety",
      tips(
        ["File FBX được sửa tại chỗ. Bản `<tên>.fbx.bak` được tạo cạnh file; nếu đã có bản .bak thì giữ nguyên bản cũ (tức bản gốc đầu tiên).", "FBX files are fixed in place. A `<name>.fbx.bak` copy is written next to each file; an existing .bak is kept (so it stays the very first original)."],
        ["**Restore backup** (trên bảng đường dẫn) khôi phục file đang chọn từ `.fbx.bak`.", "**Restore backup** (above the path table) restores the selected file from its `.fbx.bak`."],
        ["Mọi thay đổi tuỳ chọn sẽ xoá bản Preview cũ — hãy Preview lại trước khi Fix.", "Changing any option clears the old preview, so preview again before fixing."],
        ["**Rescan** quét lại, **Export** lưu báo cáo HTML / CSV (vd. gửi artist danh sách texture thiếu), **X** xoá danh sách.", "**Rescan** scans again, **Export** saves an HTML / CSV report (e.g. to send an artist the missing textures), **X** clears the list."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- blender packer

const blender: HelpTopic = {
  id: "blender",
  title: { vi: "Blender Packer", en: "Blender Packer" },
  summary: {
    vi: "Chạy Blender 5.0+ ở chế độ nền (headless) để phân tích và gom mọi file phụ thuộc của một scene .blend.",
    en: "Runs Blender 5.0+ headless to analyse and consolidate every dependency of a .blend scene.",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Khung **Blender**: Poseidon tự tìm Blender (biến môi trường `BLENDER_PATH`, PATH, Registry, Program Files\\Blender Foundation, Steam). Chọn phiên bản trong danh sách (bản cũ hơn 5.0 bị khoá) hoặc **Browse…** tới `blender.exe`; nút ↻ tìm lại.", "**Blender** card: Poseidon finds Blender by itself (`BLENDER_PATH`, PATH, the registry, Program Files\\Blender Foundation, Steam). Pick a version in the list (versions before 5.0 are disabled) or **Browse…** to `blender.exe`; ↻ searches again."],
        ["Thả file `.blend` vào cửa sổ (từ bất kỳ tab nào) hoặc bấm **Open** trong **Pack job**.", "Drop a `.blend` file on the window (from any tab) or click **Open** in **Pack job**."],
        ["Chọn **Operations** và **Output** (xem bên dưới).", "Choose **Operations** and **Output** (see below)."],
        ["Bấm **Run pack** (hoặc **Analyse** khi chỉ phân tích). Thanh tiến trình hiện từng bước; **Cancel** để dừng. Log hiện output của Blender trực tiếp.", "Click **Run pack** (or **Analyse** for analysis only). The progress bar shows each step; **Cancel** stops it. The log shows Blender's output live."],
        ["Khung **Report**: phiên bản Blender, số file thiếu, số phụ thuộc, bảng **Data-block** / **Path** / **State** (packed / found / missing, relative / absolute), đường dẫn zip và các bước đã chạy.", "The **Report**: Blender version, missing count, dependency count, the **Data-block** / **Path** / **State** table (packed / found / missing, relative / absolute), the zip path and the steps that ran."],
      ),
    ),
    section(
      "Operations",
      "Operations",
      tips(
        ["**Analyse only** — chỉ báo cáo file phụ thuộc, không thay đổi gì (khoá các tuỳ chọn ghi).", "**Analyse only** — report dependencies without changing anything (disables the writing options)."],
        ["**Consolidate** (bật sẵn) — copy file bên ngoài vào `//textures` và remap đường dẫn.", "**Consolidate** (on by default) — copy external files into `//textures` and remap."],
        ["**Unpack embedded files** — xuất ảnh đã pack ra `//textures`.", "**Unpack embedded files** — write packed images out to `//textures`."],
        ["**Make paths relative** (bật sẵn) — chuyển đường dẫn tuyệt đối thành tương đối.", "**Make paths relative** (on by default) — turn absolute paths into relative ones."],
        ["**Pack everything into the .blend** — nhúng toàn bộ vào một file .blend duy nhất.", "**Pack everything into the .blend** — embed everything in a single .blend."],
      ),
    ),
    section(
      "Output — file được ghi ở đâu",
      "Output — where files go",
      tips(
        ["**Save as a new file** (bật sẵn) — mặc định `<tên>_packed\\<tên>.blend` cạnh file gốc; sửa trực tiếp hoặc chọn bằng nút thư mục.", "**Save as a new file** (on by default) — defaults to `<name>_packed\\<name>.blend` next to the original; edit it or pick with the folder button."],
        ["Tắt **Save as a new file** sẽ **ghi đè file gốc**; Blender giữ bản trước đó dưới dạng `.blend1`.", "Turning **Save as a new file** off **overwrites the original**; Blender keeps the previous version as `.blend1`."],
        ["**Bundle a zip** — đóng gói .blend kèm `textures/` và `assets/` thành file zip (mặc định `<tên>_bundle.zip`).", "**Bundle a zip** — packs the .blend with `textures/` and `assets/` into a zip (default `<name>_bundle.zip`)."],
      ),
    ),
    section(
      "Mẹo",
      "Tips",
      tips(
        ["Chạy **Analyse only** trước để biết texture nào đang thiếu (ảnh hồng) trước khi pack.", "Run **Analyse only** first to see which textures are missing (pink) before packing."],
        ["Chỉ hoạt động trong ứng dụng desktop (cần chạy Blender thật).", "Only works in the desktop app (it runs a real Blender)."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- asset previewer

const preview: HelpTopic = {
  id: "preview",
  title: { vi: "Asset Previewer", en: "Asset Previewer" },
  summary: {
    vi: "Xem nhanh mesh 3D và texture (kể cả HDR / EXR / PSD) ngay trong ứng dụng, không cần mở DCC.",
    en: "Quickly inspect 3D meshes and textures (HDR / EXR / PSD included) inside the app, no DCC needed.",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Thả mesh, texture hoặc cả thư mục vào tab, hoặc dùng nút thư mục / file trên khung **Assets**. Nút 👁 **Preview** ở các tab khác cũng mở file tại đây.", "Drop meshes, textures or a folder onto the tab, or use the folder / file buttons on the **Assets** card. The 👁 **Preview** buttons in other tabs open files here too."],
        ["Danh sách bên trái: chuyển dạng list ↔ thumbnails, gõ **Filter** để lọc theo tên. Nút thùng rác xoá danh sách cùng preview và thumbnail đã cache.", "The list on the left: switch list ↔ thumbnails, type in **Filter** to filter by name. The trash button clears the list and cached previews / thumbnails."],
        ["Chọn một asset. Thanh phía trên hiện đường dẫn, định dạng, **Auto-reload** (tự tải lại khi file — và texture của model — thay đổi trên đĩa; chỉ có trong app desktop) và nút ↻ **Reload from disk**.", "Select an asset. The bar above shows its path, format, **Auto-reload** (reload when the file — and the model's textures — change on disk; desktop app only) and ↻ **Reload from disk**."],
      ),
      p(
        "Định dạng: 3D — FBX, OBJ (+MTL), glTF, GLB. 2D — PNG, JPG, TGA, DDS, WebP, BMP, GIF, TIFF, PSD (ảnh ghép) và HDR / EXR. File .blend thuộc về Blender Packer.",
        "Formats: 3D — FBX, OBJ (+MTL), glTF, GLB. 2D — PNG, JPG, TGA, DDS, WebP, BMP, GIF, TIFF, PSD (composite) and HDR / EXR. .blend files belong to Blender Packer.",
      ),
    ),
    section(
      "Viewport 3D",
      "3D viewport",
      keys(
        ["Left drag", "Xoay quanh model", "Orbit"],
        ["Right drag", "Pan (dịch khung nhìn)", "Pan"],
        ["Wheel", "Zoom", "Zoom"],
      ),
      tips(
        ["Chế độ hiển thị: **Shaded**, **Wireframe**, **UV checker**, **Normals**. Bật / tắt **Ground grid**, **Pivot and axes** (X đỏ, Y xanh lá, Z xanh dương), **Skeleton** (khi có bone).", "View modes: **Shaded**, **Wireframe**, **UV checker**, **Normals**. Toggle **Ground grid**, **Pivot and axes** (X red, Y green, Z blue), **Skeleton** (when there are bones)."],
        ["**Materials and textures**: vật liệu và các map; bấm tên texture để mở trong texture viewer (nút ← quay lại model). Texture thiếu hiện màu vàng kèm (missing).", "**Materials and textures**: materials and their maps; click a texture to open it in the texture viewer (← returns to the model). Missing textures show in amber with (missing)."],
        ["**Lighting and environment**: **Environment** = Studio (built-in), None (chỉ đèn), file HDR / EXR trong thư mục hoặc **Browse for HDR / EXR…**; **Exposure**, **Env strength**, **Key light** (Direction, Height, Intensity), **Light follows the camera**, **Show environment as background**. Nhấp đúp thanh trượt để reset.", "**Lighting and environment**: **Environment** = Studio (built-in), None (lights only), an HDR / EXR from the folder or **Browse for HDR / EXR…**; **Exposure**, **Env strength**, **Key light** (Direction, Height, Intensity), **Light follows the camera**, **Show environment as background**. Double-click a slider to reset it."],
        ["Bảng thông số: Triangles, Vertices, Meshes, Materials, UV sets, Bones, Animations, Size (units), File unit; kèm cảnh báo texture thiếu.", "Stats: Triangles, Vertices, Meshes, Materials, UV sets, Bones, Animations, Size (units), File unit; plus missing-texture warnings."],
        ["Animation: Play / Pause, chọn clip, thanh thời gian, tốc độ 0.25× – 2×.", "Animation: Play / Pause, clip picker, timeline, speed 0.25× – 2×."],
        ["**Reset camera**; **Save view as PNG** lưu ảnh nền trong suốt, độ phân giải ×2, tên mặc định `<tên>_preview.png`.", "**Reset camera**; **Save view as PNG** saves a transparent-background image at 2× resolution, default name `<name>_preview.png`."],
      ),
    ),
    section(
      "Texture viewer",
      "Texture viewer",
      tips(
        ["Kéo để pan, cuộn chuột để zoom; **Fit to view** và **Actual size (100%)**.", "Drag to pan, wheel to zoom; **Fit to view** and **Actual size (100%)**."],
        ["Kênh hiển thị: RGBA, RGB, A, R, G, B — tiện kiểm tra từng kênh của ORM / mask.", "Channels: RGBA, RGB, A, R, G, B — handy for checking ORM / mask channels."],
        ["**Exposure** (−5 … +5) và **Gamma** (mặc định 2.2), hữu ích cho HDR / EXR; nhấp đúp để reset.", "**Exposure** (−5 … +5) and **Gamma** (default 2.2), useful for HDR / EXR; double-click to reset."],
        ["Thông tin: **Format**, **Size**, **Data** (float linear hoặc 8-bit sRGB).", "Info: **Format**, **Size**, **Data** (float linear or 8-bit sRGB)."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- pipeline tools

const tools: HelpTopic = {
  id: "tools",
  title: { vi: "Pipeline Tools", en: "Pipeline Tools" },
  summary: {
    vi: "Sáu tiện ích texture và mesh: ORM packer, Converter (bên trái); Duplicates, Unused textures, Texture sets, Meshes (bên phải).",
    en: "Six texture and mesh utilities: ORM packer, Converter (left); Duplicates, Unused textures, Texture sets, Meshes (right).",
  },
  sections: [
    section(
      "Bố cục",
      "Layout",
      tips(
        ["Khung trái chuyển giữa **ORM packer** và **Converter**. Khi Converter đang mở, ảnh thả vào cửa sổ được thêm vào Converter; ngược lại chúng được gán vào các slot ORM theo tên.", "The left card switches between **ORM packer** and **Converter**. While Converter is shown, dropped images go to it; otherwise they fill the ORM slots by name."],
        ["Khung phải phân tích một thư mục: chọn tab, **Choose…** thư mục rồi bấm nút chạy. Thả thư mục vào cửa sổ sẽ chạy ngay công cụ đang chọn.", "The right card analyses a folder: pick a tab, **Choose…** a folder, then click the run button. Dropping a folder on the window runs the selected tool straight away."],
        ["**Export** lưu kết quả HTML / CSV. Rê chuột lên một file để hiện nút **Preview** và **Show in Explorer**.", "**Export** saves the result as HTML / CSV. Hover a file to reveal **Preview** and **Show in Explorer**."],
      ),
    ),
    section(
      "ORM packer",
      "ORM packer",
      steps(
        ["Thả các map tên `…_ao`, `…_roughness`, `…_metallic` vào cửa sổ (tự gán theo hậu tố, kể cả occlusion, rough, gloss, smoothness, metalness…) hoặc bấm **Pick** ở từng slot.", "Drop maps named `…_ao`, `…_roughness`, `…_metallic` onto the window (assigned by suffix, including occlusion, rough, gloss, smoothness, metalness…) or click **Pick** on each slot."],
        ["Tick **Roughness input is a gloss / smoothness map** nếu map là gloss (tự tick khi tên có gloss / smooth) — nó sẽ được đảo ngược.", "Tick **Roughness input is a gloss / smoothness map** for gloss maps (ticked automatically when the name says gloss / smooth) — it is inverted."],
        ["**Output** tự đặt thành `T_<Tên>_ORM.png` cạnh map đầu tiên; sửa hoặc chọn nơi lưu, chọn **PNG** / **TGA**.", "**Output** defaults to `T_<Name>_ORM.png` next to the first map; edit or browse, and choose **PNG** / **TGA**."],
        ["Bấm **Pack ORM texture**. Kết quả có nút Preview và Show in Explorer.", "Click **Pack ORM texture**. The result has Preview and Show in Explorer buttons."],
      ),
      tips(
        ["Kênh: **R** = Ambient occlusion, **G** = Roughness, **B** = Metallic. Slot trống dùng mặc định: AO trắng (1.0), Roughness 0.5, Metallic đen (0.0).", "Channels: **R** = ambient occlusion, **G** = roughness, **B** = metallic. Empty slots use defaults: AO white (1.0), roughness 0.5, metallic black (0.0)."],
        ["Map nhỏ hơn được resample về kích thước map lớn nhất.", "Smaller maps are resampled to the largest one."],
        ["Lưu ý: file output trùng tên sẽ bị **ghi đè mà không hỏi**.", "Note: an existing output file is **overwritten without asking**."],
      ),
    ),
    section(
      "Converter",
      "Converter",
      steps(
        ["Chuyển khung trái sang **Converter**. Thả texture vào cửa sổ hoặc bấm **+ File** / **+ Folder** (thư mục được quét cả thư mục con).", "Switch the left card to **Converter**. Drop textures on the window or click **+ File** / **+ Folder** (folders are searched recursively)."],
        ["**Max size** (mặc định 2048 px; **Keep size** = giữ nguyên): chỉ thu nhỏ để cạnh dài nhất không vượt quá giá trị, giữ tỉ lệ. **Format**: Same as source, PNG, TGA, JPG, DDS (uncompressed + mips).", "**Max size** (default 2048 px; **Keep size** = unchanged): only scales down so the longest side fits, keeping the aspect ratio. **Format**: Same as source, PNG, TGA, JPG, DDS (uncompressed + mips)."],
        ["Tuỳ chọn **Snap to power of two** (vd. 1000 × 300 → 1024 × 256) và **Flip green channel** (normal map DirectX / UE ↔ OpenGL / Unity, Blender).", "Optionally **Snap to power of two** (e.g. 1000 × 300 → 1024 × 256) and **Flip green channel** (normal maps DirectX / UE ↔ OpenGL / Unity, Blender)."],
        ["**Output folder** (mặc định `converted`, tương đối với thư mục của từng file nguồn, hoặc một đường dẫn tuyệt đối) và **Suffix** (vd. `_GL`).", "**Output folder** (default `converted`, relative to each source's folder, or an absolute path) and **Suffix** (e.g. `_GL`)."],
        ["Bấm **Dry run** để xem kế hoạch (kích thước mới, file bị bỏ qua), rồi **Convert**. **Report** xuất kết quả.", "Click **Dry run** to see the plan (new sizes, skipped files), then **Convert**. **Report** exports the result."],
      ),
      tips(
        ["File output đã tồn tại bị bỏ qua (skipped) trừ khi bật **Overwrite existing files** — kể cả trường hợp output trùng chính file nguồn.", "Existing outputs are skipped unless **Overwrite existing files** is on — including when the output would be the source file itself."],
        ["Nguồn HDR / EXR bị bỏ qua (xuất 8-bit sẽ cắt dải sáng); DDS không được nhận làm đầu vào. PSD thì được.", "HDR / EXR sources are skipped (8-bit output would clip them); DDS is not accepted as input. PSD is."],
      ),
    ),
    section(
      "Duplicates",
      "Duplicates",
      steps(["Chọn tab **Duplicates**, chọn thư mục, bấm **Find duplicates**.", "Pick the **Duplicates** tab, choose a folder, click **Find duplicates**."]),
      tips(
        ["File được nhóm theo kích thước rồi băm XXH3-128 song song; mỗi nhóm là các file giống hệt từng byte. Hiển thị số nhóm và dung lượng **reclaimable** nếu chỉ giữ một bản.", "Files are grouped by size, then hashed with XXH3-128 in parallel; each group is byte-identical files. Shows the group count and the **reclaimable** space if you keep one copy."],
        ["Poseidon không xoá gì — dùng **Show in Explorer** để tự xử lý.", "Poseidon deletes nothing — use **Show in Explorer** to deal with them yourself."],
      ),
    ),
    section(
      "Unused textures",
      "Unused textures",
      steps(["Chọn tab **Unused textures**, chọn thư mục, bấm **Find unused**.", "Pick the **Unused textures** tab, choose a folder, click **Find unused**."]),
      tips(
        ["Mọi file FBX, OBJ / MTL, glTF và GLB trong thư mục được đọc và so với texture trên đĩa; kết quả là texture không file nào tham chiếu, kèm dung lượng có thể thu hồi.", "Every FBX, OBJ / MTL, glTF and GLB under the folder is read and compared with the textures on disk; the result is the textures nothing references, with the reclaimable size."],
        ["Tick **Read .blend files** để tính cả scene Blender (cần Blender 5.0+, mỗi file một lần chạy nền). Nếu có .blend chưa được đọc, texture chỉ dùng trong scene đó cũng nằm trong danh sách — kiểm tra kỹ trước khi xoá.", "Tick **Read .blend files** to include Blender scenes (needs Blender 5.0+, one headless run per file). If some .blend files were not read, textures used only by them appear in the list too — review before deleting."],
        ["Chỉ báo cáo, không xoá file nào.", "Report only; nothing is deleted."],
      ),
    ),
    section(
      "Texture sets",
      "Texture sets",
      steps(
        ["Chọn tab **Texture sets**, chọn thư mục, bấm **Match sets**: texture được nhóm theo material dựa vào hậu tố (`_BaseColor`, `_N`, `_Roughness`…).", "Pick the **Texture sets** tab, choose a folder, click **Match sets**: textures are grouped into material sets by suffix (`_BaseColor`, `_N`, `_Roughness`…)."],
        ["Bảng hiện từng set với các cột Base color, Normal, ORM, Roughness, Metallic, AO (✓ — bấm để xem; \"gloss\" khi chỉ có gloss) và cột **Missing**.", "The table shows each set with Base color, Normal, ORM, Roughness, Metallic, AO columns (✓ — click to preview; \"gloss\" when only a gloss map exists) and a **Missing** column."],
        ["Tick các set cần pack (hoặc **Select all N packable**), chọn PNG / TGA, bấm **Pack N ORM**. Danh sách được quét lại sau khi pack.", "Tick the sets to pack (or **Select all N packable**), choose PNG / TGA, click **Pack N ORM**. The list is rescanned afterwards."],
      ),
      tips(
        ["Set **ready for ORM** = chưa có map ORM và có ít nhất một trong roughness / gloss / metallic / AO. File ORM được ghi thành `T_<Tên>_ORM` trong thư mục của set.", "A set is **ready for ORM** when it has no ORM map yet and at least one of roughness / gloss / metallic / AO. The ORM is written as `T_<Name>_ORM` in the set's folder."],
        ["Texture không có hậu tố map nhận biết được đếm riêng (rê chuột để xem danh sách).", "Textures without a recognisable map suffix are counted separately (hover to see them)."],
      ),
    ),
    section(
      "Meshes",
      "Meshes",
      steps(
        ["Thả file mesh vào cửa sổ khi đang ở Pipeline Tools (tự chuyển sang tab **Meshes**), hoặc chọn thư mục rồi bấm **Inspect meshes**.", "Drop mesh files on the window while in Pipeline Tools (switches to **Meshes**), or choose a folder and click **Inspect meshes**."],
        ["Tuỳ chọn **Triangle budget**: file vượt ngân sách sẽ bị cảnh báo.", "Optional **Triangle budget**: files over it are flagged."],
      ),
      tips(
        ["Bảng: File (định dạng, số mesh, trục Up), Tris, Verts, Mat, UV, Size, Units. Kích thước tính theo đơn vị của file, trước transform của node.", "Columns: File (format, mesh count, up axis), Tris, Verts, Mat, UV, Size, Units. Sizes are in file units, before node transforms."],
        ["Cảnh báo thường gặp: không có UV, thiếu normal, vượt ngân sách tam giác, đơn vị lạ, kích thước quá lớn (kiểm tra scale khi export).", "Typical warnings: no UV set, missing normals, over the triangle budget, unusual unit scale, very large size (check the export scale)."],
        ["Đọc trực tiếp file, không cần mở viewport — nhanh khi audit cả loạt mesh.", "Files are read directly, no viewport needed — fast for auditing many meshes."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- recipes

const recipes: HelpTopic = {
  id: "recipes",
  title: { vi: "Recipes", en: "Recipes" },
  summary: {
    vi: "Ghép nhiều công cụ thành một quy trình chạy lặp lại được — trong ứng dụng hoặc từ dòng lệnh.",
    en: "Chain tools into one repeatable run — in the app or from the command line.",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Đặt **Name** cho recipe, hoặc chọn **Templates…**: Unreal Engine 5 import prep, Unity import prep, Asset audit (read only). Khi mở ứng dụng, mẫu UE5 được nạp sẵn.", "Name the recipe, or pick **Templates…**: Unreal Engine 5 import prep, Unity import prep, Asset audit (read only). The UE5 template is loaded at start."],
        ["**Add step…** để thêm bước; mũi tên lên / xuống đổi thứ tự, thùng rác xoá. Mỗi bước có tuỳ chọn riêng.", "**Add step…** adds a step; the up / down arrows reorder, the trash icon removes. Each step has its own options."],
        ["**Save** lưu recipe thành file `.json`; **Open** mở recipe đã lưu (hoặc thả file .json vào tab).", "**Save** writes the recipe to a `.json` file; **Open** loads a saved one (or drop the .json on the tab)."],
        ["Thả thư mục cần xử lý vào tab hoặc bấm **Choose…**.", "Drop the folder to process on the tab, or click **Choose…**."],
        ["Giữ **Dry run** (bật sẵn) và bấm **Preview run** — liệt kê mọi thay đổi mà không ghi gì. Khi đã ổn, bỏ tick Dry run và bấm **Run for real** (nút màu vàng).", "Keep **Dry run** (on by default) and click **Preview run** — it lists every change without writing anything. When it looks right, untick Dry run and click **Run for real** (the amber button)."],
        ["Xem kết quả từng bước (bấm vào bước để mở chi tiết); **Export** lưu báo cáo HTML / CSV.", "Review each step's outcome (click a step for details); **Export** saves an HTML / CSV report."],
      ),
    ),
    section(
      "Các loại bước",
      "Step types",
      tips(
        ["**Rename assets** — UE5 preset / Unity preset; **Use Renamer rules** chép các quy tắc đang bật ở tab Batch Renamer (hiện là Custom); **Include subfolders**. Hoàn tác từ tab Batch Renamer.", "**Rename assets** — UE5 preset / Unity preset; **Use Renamer rules** copies the enabled rules from Batch Renamer (shown as Custom); **Include subfolders**. Undo from the Batch Renamer tab."],
        ["**Fix FBX texture paths** — Relative / Strip / Collect (kèm **Subfolder**), **Rewrite textures that cannot be found**; luôn tạo `.fbx.bak`.", "**Fix FBX texture paths** — Relative / Strip / Collect (with **Subfolder**), **Rewrite textures that cannot be found**; always keeps `.fbx.bak` backups."],
        ["**Pack ORM textures** — một ORM cho mỗi texture set có roughness / metallic / AO; PNG / TGA; **Replace existing ORM files**.", "**Pack ORM textures** — one ORM per texture set with roughness / metallic / AO; PNG / TGA; **Replace existing ORM files**."],
        ["**Convert textures** — Max size, định dạng, **Power of two**, **Flip green**, **Overwrite**, **Name contains** (chỉ xử lý file có tên chứa chuỗi này), **Output folder**, **Suffix**.", "**Convert textures** — max size, format, **Power of two**, **Flip green**, **Overwrite**, **Name contains** (only files whose name contains it), **Output folder**, **Suffix**."],
        ["**Inspect meshes** — chỉ báo cáo; **Triangle budget per file**.", "**Inspect meshes** — report only; **Triangle budget per file**."],
        ["**Find unused textures** (tuỳ chọn **Also read .blend files**) và **Find duplicates** — chỉ báo cáo, không xoá gì.", "**Find unused textures** (optionally **Also read .blend files**) and **Find duplicates** — report only, nothing is deleted."],
      ),
    ),
    section(
      "Chạy an toàn",
      "Running safely",
      tips(
        ["Các bước chạy lần lượt theo thứ tự. Nếu một bước lỗi, recipe dừng lại (\"Stopped after a failed step\").", "Steps run in order. If one fails, the recipe stops (\"Stopped after a failed step\")."],
        ["Luôn chạy **Preview run** trước: kết quả có nhãn \"Dry run: nothing changed\".", "Always do a **Preview run** first: its result is labelled \"Dry run: nothing changed\"."],
      ),
    ),
    section(
      "Dòng lệnh",
      "Command line",
      p(
        "Thanh dưới cùng hiện lệnh tương ứng với recipe và thư mục hiện tại; bấm biểu tượng copy để chép. Cần **Save** recipe trước để lệnh có đường dẫn file. Ví dụ: `poseidon.exe --recipe ue5-prep.json D:\\Assets\\Props --dry-run --report report.json`.",
        "The bottom bar shows the matching command for the current recipe and folder; click the copy icon to copy it. **Save** the recipe first so the command has its file path. Example: `poseidon.exe --recipe ue5-prep.json D:\\Assets\\Props --dry-run --report report.json`.",
      ),
      tips(
        ["`--dry-run` chỉ xem trước; `--report <file.json>` ghi báo cáo; `--blender <blender.exe>` chỉ định Blender.", "`--dry-run` previews only; `--report <file.json>` writes a report; `--blender <blender.exe>` picks the Blender to use."],
        ["Mã thoát: 0 = mọi bước thành công, 1 = có bước lỗi, 2 = sai tham số hoặc recipe không hợp lệ. Trong cmd dùng `start /wait poseidon.exe …` để chờ kết quả.", "Exit codes: 0 = every step succeeded, 1 = a step failed, 2 = bad arguments or an invalid recipe. In cmd use `start /wait poseidon.exe …` to wait for it."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- dashboard

const dashboard: HelpTopic = {
  id: "dashboard",
  title: { vi: "Dashboard", en: "Dashboard" },
  summary: {
    vi: "“Bộ bàn giao này có gì?” — số lượng và dung lượng asset theo loại và theo package (thư mục con).",
    en: "“What is in this delivery?” — asset counts and sizes by type and by package (sub-folder).",
  },
  sections: [
    section(
      "Cách dùng",
      "How to use",
      steps(
        ["Thả thư mục asset (ổ local hoặc Google Drive, vd. `G:\\Shared drives\\…`) hoặc bấm **Choose…** / menu ☁.", "Drop an asset folder (local or Google Drive, e.g. `G:\\Shared drives\\…`) or use **Choose…** / the ☁ menu."],
        ["Các ô tổng: **Assets**, **Total size**, **Packages**, **Meshes**, **Textures**.", "Totals: **Assets**, **Total size**, **Packages**, **Meshes**, **Textures**."],
        ["**By asset type**: Meshes / Textures / Scenes / Sources, kèm phân bổ **By format**. Rê chuột để xem chi tiết.", "**By asset type**: Meshes / Textures / Scenes / Sources, with a **By format** breakdown. Hover for details."],
        ["**By package**: cột chồng theo thư mục con. Chọn cấp **Top folders** / **2 folder levels** / **3 folder levels**, chuyển **Chart** / **Table**.", "**By package**: stacked bars per sub-folder. Choose **Top folders** / **2 folder levels** / **3 folder levels**, switch **Chart** / **Table**."],
        ["**Files** / **Size** đổi chỉ số. Bấm một package để đi vào trong, ↖ **Up one folder** để ra ngoài, **Refresh** để quét lại, **Export** lưu HTML / CSV.", "**Files** / **Size** switches the metric. Click a package to open it, ↖ **Up one folder** to go back out, **Refresh** to rescan, **Export** for HTML / CSV."],
      ),
    ),
    section(
      "Lưu ý",
      "Notes",
      tips(
        ["Dashboard chỉ đọc tên và kích thước file, nên có thể xem cả một Shared drive mà không tải file nào về máy.", "Only file names and sizes are read, so you can survey a whole shared drive without downloading anything."],
        ["Dùng trước Asset Matcher để chọn package cần xử lý.", "Use it before Asset Matcher to pick the package to work on."],
      ),
    ),
  ],
};

// ---------------------------------------------------------------- asset matcher + kit assembler

const matcher: HelpTopic = {
  id: "matcher",
  title: { vi: "Asset Matcher & Kit Assembler", en: "Asset Matcher & Kit Assembler" },
  summary: {
    vi: "Tự xác định texture set nào đi với mesh / material slot nào, rồi lắp thành bộ kit sạch cho UE5 hoặc Unity.",
    en: "Works out which texture set goes with which mesh / material slot, then assembles a clean kit for UE5 or Unity.",
  },
  sections: [
    section(
      "Asset Matcher — cách dùng",
      "Asset Matcher — how to use",
      steps(
        ["Thả thư mục bàn giao (hoặc một package) vào tab, hoặc bấm **Choose…** / menu ☁.", "Drop a delivery folder (or one package) onto the tab, or use **Choose…** / the ☁ menu."],
        ["Với thư mục trên Google Drive, nếu cần đọc (tải) hơn 64 MB mesh, Poseidon hỏi trước: **Read meshes** hoặc **Not now**. Mẹo: chọn một package để đọc ít hơn. Texture chỉ được liệt kê theo tên.", "For a Google Drive folder that needs more than 64 MB of meshes read (downloaded), Poseidon asks first: **Read meshes** or **Not now**. Tip: pick a single package to read less. Textures are only listed by name."],
        ["Mỗi mesh (FBX, OBJ, glTF, GLB) và mỗi material slot nhận một texture set, kèm điểm tin cậy 0–100: ưu tiên đường dẫn texture trong mesh, rồi tên material / tên file, rồi thư mục.", "Each mesh (FBX, OBJ, glTF, GLB) and material slot gets a texture set with a 0–100 confidence: texture paths inside the mesh first, then material and file names, then folders."],
        ["Lọc **All** / **To decide** (slot Review chưa chọn và slot No match) / **Review** / **No match**, hoặc gõ vào ô **Filter mesh, material, set**.", "Filter **All** / **To decide** (Review slots not picked yet and No match slots) / **Review** / **No match**, or type in **Filter mesh, material, set**."],
        ["Đổi set bằng dropdown của từng slot (dấu ✎ = chọn tay), hoặc **Accept best for reviews** để nhận ứng viên tốt nhất cho mọi slot Review chưa chọn.", "Change a set with the slot's dropdown (✎ = picked by hand), or **Accept best for reviews** to take the top candidate for every unpicked Review slot."],
        ["**Save manifest** ghi `asset_manifest.json`; **Export** lưu HTML / CSV; **Assemble kit…** mở Kit Assembler.", "**Save manifest** writes `asset_manifest.json`; **Export** saves HTML / CSV; **Assemble kit…** opens the Kit Assembler."],
      ),
    ),
    section(
      "Trạng thái",
      "Statuses",
      tips(
        ["**Exact** — file mesh tham chiếu đúng texture của set.", "**Exact** — the mesh file references this texture set."],
        ["**Likely** — thắng rõ ràng theo tên material / tên mesh.", "**Likely** — a clear winner by material / mesh name."],
        ["**Review** — nhiều set điểm gần bằng nhau hoặc bằng chứng yếu: bạn tự chọn.", "**Review** — a close call or weak evidence: you pick."],
        ["**No match** — không set nào đủ điểm.", "**No match** — no set scored high enough."],
      ),
    ),
    section(
      "Panel chi tiết và cache",
      "Details panel and cache",
      tips(
        ["Chọn một slot để xem **Candidates** và lý do; **Use** để chọn, **No texture** để bỏ trống, **Auto** để quay về lựa chọn của matcher. Kèm danh sách map của set (bấm để mở trong Explorer) và **Texture paths inside the mesh file**.", "Select a slot to see its **Candidates** and reasons; **Use** picks one, **No texture** leaves it empty, **Auto** returns to the matcher's pick. Also lists the set's maps (click to show in Explorer) and the **Texture paths inside the mesh file**."],
        ["Khi chưa chọn slot, panel liệt kê **Texture sets no mesh uses** và **Textures without a map suffix**.", "With no slot selected it lists **Texture sets no mesh uses** and **Textures without a map suffix**."],
        ["Kết quả đọc mesh được cache: lần quét sau chỉ đọc file mới / đã đổi (\"N read · M cached\"); **clear** xoá cache. **Refresh** match lại mà vẫn giữ lựa chọn của bạn. **Cancel** khi đang đọc — mesh đã đọc vẫn được giữ trong cache.", "Mesh reads are cached: the next match only reads new or changed files (\"N read · M cached\"); **clear** forgets the cache. **Refresh** matches again and keeps your picks. **Cancel** while reading — meshes read so far stay cached."],
      ),
    ),
    section(
      "Kit Assembler",
      "Kit Assembler",
      steps(
        ["Bấm **Assemble kit…** sau khi match, hoặc **Assemble from manifest…** (khi chưa có kết quả) / Ctrl+K → **Assemble kit from manifest…** để dùng `asset_manifest.json` đã lưu.", "Click **Assemble kit…** after matching, or **Assemble from manifest…** (when there is no result) / Ctrl+K → **Assemble kit from manifest…** to use a saved `asset_manifest.json`."],
        ["**Destination (project folder)**, vd. `<UE project>\\Content\\Environment`.", "**Destination (project folder)**, e.g. `<UE project>\\Content\\Environment`."],
        ["**Naming**: **Unreal (UE5)** (`SM_Wall_Corner_01.fbx`, `T_Wall_Corner_D.png`, `T_Wall_Corner_ORM.png`), **Unity** (`WallCorner01.fbx`, `WallCorner_BaseColor.png`) hoặc **Keep names**. **Mesh folder** / **Texture folder** mặc định `Meshes` / `Textures`.", "**Naming**: **Unreal (UE5)** (`SM_Wall_Corner_01.fbx`, `T_Wall_Corner_D.png`, `T_Wall_Corner_ORM.png`), **Unity** (`WallCorner01.fbx`, `WallCorner_BaseColor.png`) or **Keep names**. **Mesh folder** / **Texture folder** default to `Meshes` / `Textures`."],
        ["Bảng kế hoạch (dry run) hiện ngay khi có Destination: **Kind**, **In the kit**, **From**, **Status** (Will write / Kept / …). Kiểm tra rồi bấm **Assemble N file(s)**, sau đó **Show kit**.", "The plan (a dry run) appears once a destination is set: **Kind**, **In the kit**, **From**, **Status** (Will write / Kept / …). Check it, click **Assemble N file(s)**, then **Show kit**."],
      ),
      tips(
        ["**Pack ORM maps** (bật sẵn) — roughness / gloss / metallic / AO gộp thành một ORM; các map rời không được copy.", "**Pack ORM maps** (on by default) — roughness / gloss / metallic / AO become one ORM texture; the separate maps are not copied."],
        ["**Relink texture paths in meshes** (bật sẵn) — bản copy FBX, OBJ-MTL, glTF trỏ tới texture đã copy (đường dẫn tương đối).", "**Relink texture paths in meshes** (on by default) — the FBX, OBJ-MTL and glTF copies point at the copied textures (relative paths)."],
        ["**Keep package folders** — giữ cấu trúc `Wall Modular/Meshes/…` thay vì gộp chung `Meshes/` và `Textures/`.", "**Keep package folders** — `Wall Modular/Meshes/…` instead of one shared `Meshes/` and `Textures/`."],
        ["**Include unconfirmed matches** — slot Review chưa ai chọn sẽ lấy ứng viên tốt nhất; tắt thì bị bỏ ra (\"Left out\").", "**Include unconfirmed matches** — unpicked Review slots take the top candidate; off leaves them out (\"Left out\")."],
        ["**Overwrite files already in the destination** — tắt (mặc định, và luôn tắt khi mở lại): file đã có được giữ và bỏ qua.", "**Overwrite files already in the destination** — off (the default, and always off when reopened): existing files are kept and skipped."],
      ),
    ),
    section(
      "An toàn",
      "Safety",
      tips(
        ["Thư mục bàn giao chỉ được đọc: không file nào trong đó bị đổi tên, ghi đè hay xoá.", "The delivery folder is only read: nothing in it is renamed, overwritten or deleted."],
        ["`kit_manifest.json` được ghi vào thư mục đích, ghi lại kết quả. Destination và các tuỳ chọn được nhớ cho lần sau (trừ Overwrite).", "`kit_manifest.json` is written to the destination as a record. The destination and options are remembered (except Overwrite)."],
        ["Quy trình gợi ý: Dashboard → Asset Matcher → Kit Assembler → project UE5 / Unity.", "Suggested flow: Dashboard → Asset Matcher → Kit Assembler → UE5 / Unity project."],
      ),
    ),
  ],
};

/** Every Help topic, in navigation order. */
export const HELP_TOPICS: HelpTopic[] = [gettingStarted, renamer, fbx, blender, preview, tools, recipes, dashboard, matcher];
