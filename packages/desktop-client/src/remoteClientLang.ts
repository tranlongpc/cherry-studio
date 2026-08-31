import deDE from '@main/i18n/locales/de-de.json'
import elGR from '@main/i18n/locales/el-gr.json'
import enUS from '@main/i18n/locales/en-us.json'
import esES from '@main/i18n/locales/es-es.json'
import frFR from '@main/i18n/locales/fr-fr.json'
import jaJP from '@main/i18n/locales/ja-jp.json'
import ptPT from '@main/i18n/locales/pt-pt.json'
import roRO from '@main/i18n/locales/ro-ro.json'
import ruRU from '@main/i18n/locales/ru-ru.json'
import viVN from '@main/i18n/locales/vi-vn.json'
import zhCN from '@main/i18n/locales/zh-cn.json'
import zhTW from '@main/i18n/locales/zh-tw.json'
import { app } from 'electron'

type RemoteClientTrayKey = 'tray.quit' | 'tray.show_quick_assistant' | 'tray.show_window'

const locales: Record<string, Record<RemoteClientTrayKey, string>> = {
  'de-DE': deDE,
  'el-GR': elGR,
  'en-US': enUS,
  'es-ES': esES,
  'fr-FR': frFR,
  'ja-JP': jaJP,
  'pt-PT': ptPT,
  'ro-RO': roRO,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'zh-CN': zhCN,
  'zh-TW': zhTW
}

export function lang(key: RemoteClientTrayKey): string {
  const locale = app.getLocale()
  const language = Object.keys(locales).find((candidate) => candidate.toLowerCase() === locale.toLowerCase())
  return locales[language ?? 'en-US'][key]
}
