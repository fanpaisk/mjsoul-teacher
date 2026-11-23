; 雀魂教练 —— Inno Setup 6 安装脚本
; 编译：ISCC.exe /DMyVersion=1.25.0 installer.iss
; 没有 Inno Setup 也能用：build\package.ps1 会跳过安装器，只产 dist\MahjongSoulCoach\
;
; 设计要点：
;   · PrivilegesRequired=lowest → 装到 %LOCALAPPDATA%，不弹 UAC（这是"像正经工具"的关键一步）
;   · 不提供开机自启（DECISIONS D11：用户明确拒绝）
;   · 卸载默认保留 %APPDATA%\MahjongSoulCoach\config.json 与已下载的模型，重装不用再下 42MB

#define MyAppName "雀魂教练"
#ifndef MyVersion
  #define MyVersion "1.25.0"
#endif
#define MyAppPublisher "mjsoul-teacher"
#define MyAppExeName "CoachTray.exe"
#define MyAppId "{{A7F1C3D2-5B64-4E8A-9C31-2F0B7D51E9A4}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyVersion}
AppVerName={#MyAppName} {#MyVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\MahjongSoulCoach
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=MahjongSoulCoach-Setup-{#MyVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
CloseApplications=yes
SetupLogging=yes

[Languages]
; Inno Setup 6 默认不带简体中文，随包放一份官方 isl（来源 jrsoftware/issrc 的 Files/Languages）
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Files]
; 整个发行目录（assemble.ps1 的产物）
Source: "..\dist\MahjongSoulCoach\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\设置向导"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 运行产物（配置与模型在 %APPDATA%，故意保留）
Type: files; Name: "{app}\live\live_coach.md"
Type: files; Name: "{app}\live\live_observed.log"
Type: files; Name: "{app}\live\server.log"
Type: filesandordirs; Name: "{app}\live\mjb\__pycache__"

[Code]
// 装完后若检测到没有模型，提示用户去向导里下载（不阻断安装）
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not FileExists(ExpandConstant('{app}\live\mjb\mortal_full.pth')) then
      MsgBox('模型权重没有随安装包一起带上（约 42 MB）。' + #13#10 +
             '启动后会自动打开设置向导，点"下载模型"即可。', mbInformation, MB_OK);
  end;
end;
