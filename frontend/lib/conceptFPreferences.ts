import {recordedTimeZone} from './conceptFProfile';

export type PreferencesDraft={timezone:string;notification_preferences:string;theme_preference:string};
export type VerifiedPreferences={timezone:string;notification_preferences:'all'|'important'|'none';theme_preference:'light'|'dark'|'system'};
const notifications=new Set(['all','important','none']);
const themes=new Set(['light','dark','system']);

/** Missing/unsupported saved values require an explicit choice, never an invented default. */
export function savedPreferences(value:unknown):PreferencesDraft {
 const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 return {timezone:recordedTimeZone(row.timezone)??'',
  notification_preferences:typeof row.notification_preferences==='string'&&notifications.has(row.notification_preferences)?row.notification_preferences:'',
  theme_preference:typeof row.theme_preference==='string'&&themes.has(row.theme_preference)?row.theme_preference:''};
}
export function preferencesReady(value:PreferencesDraft):value is VerifiedPreferences {
 return recordedTimeZone(value.timezone)!==null&&notifications.has(value.notification_preferences)&&themes.has(value.theme_preference);
}
