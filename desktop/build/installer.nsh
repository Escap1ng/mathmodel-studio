# 安装器默认装到桌面的「MathModel Studio」文件夹；赛题工作区由程序首次打开时另建在桌面。
# electron-builder 自动 include build/installer.nsh。preInit 早于安装模式页执行，
# 而 setInstallModePerUser 会先读 HKCU 的 InstallLocation，所以写这个值就能改默认目录。
# 现有安装还在原处时（升级）沿用原路径；记录的地点已经没有程序了（比如手动删了目录，
# 或旧版本装进了赛题文件夹），就当没有旧安装，回到桌面默认。
!include "LogicLib.nsh"

!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 == ""
    ${OrIfNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$DESKTOP\${APP_FILENAME}"
    ${EndIf}
  !endif
!macroend

# 安装模式页也能选「所有用户」；那种情况实际装在 Program Files，
# preInit 写的当前用户默认值要清掉，免得上层把那里当成已有的当前用户安装。
!macro customInstall
  !ifndef INSTALL_MODE_PER_ALL_USERS
    ${If} $installMode == "all"
      DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${EndIf}
  !endif
!macroend
