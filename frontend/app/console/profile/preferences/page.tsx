"use client";

import { useEffect, useRef, useState } from "react";
import {useSession} from "next-auth/react";
import { ModulePreferences } from "@/components/modules/ModulePreferences";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { apiService } from "@/services/api";
import {savedPreferences,preferencesReady,type PreferencesDraft} from '@/lib/conceptFPreferences';
import {recordedTimeZone} from '@/lib/conceptFProfile';
import { FormAlert } from "@/components/auth/FormAlert";
import {
  applyThemePreference,
  getStoredThemePreference,
  isThemePreference,
  persistThemePreference,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type PreferencesFormData=PreferencesDraft;
const timezones=[['UTC','UTC'],['America/New_York','Eastern Time (US & Canada)'],['America/Chicago','Central Time (US & Canada)'],['America/Denver','Mountain Time (US & Canada)'],['America/Los_Angeles','Pacific Time (US & Canada)'],['Europe/London','London'],['Europe/Paris','Paris'],['Asia/Tokyo','Tokyo'],['Asia/Kolkata','India Standard Time'],['Asia/Calcutta','India Standard Time (saved alias)']];

export default function PreferencesPage(){
  const {data:session,status}=useSession();
  if(status!=='authenticated'||!session?.user?.id)return <p role="status">Verifying your private preferences…</p>;
  return <OwnedPreferencesPage key={`${session.user.id}:${session.generation}`}/>;
}
function OwnedPreferencesPage() {
  const [loading, setLoading] = useState(false);
  const [loaded,setLoaded]=useState(false),[reload,setReload]=useState(0);
  const [readError,setReadError]=useState<string|null>(null);
  const saving=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [formData, setFormData] = useState<PreferencesFormData>({
    timezone: "",
    notification_preferences: "",
    theme_preference: "",
  });

  useEffect(() => {
    let active=true;
    async function loadPreferences() {
      setLoaded(false);setReadError(null);
      try {
        const profile=await apiService.getProfile();
        if(!active)return;
        const saved=savedPreferences(profile);
        setFormData(saved);setLoaded(true);setError(null);
        if(isThemePreference(saved.theme_preference)){persistThemePreference(saved.theme_preference);applyThemePreference(saved.theme_preference);}
      } catch {
        if(active)setReadError('Saved ordinary preferences could not be verified. Reload before editing this form.');
      }
    }
    loadPreferences();
    return()=>{active=false;};
  }, [reload]);

  useEffect(()=>{
    const changed=(event:Event)=>{if(event instanceof StorageEvent&&event.key!==null&&event.key!==THEME_STORAGE_KEY)return;const value=event instanceof CustomEvent?event.detail:getStoredThemePreference();if(isThemePreference(value))setFormData(previous=>({...previous,theme_preference:value}));};
    window.addEventListener(THEME_CHANGED_EVENT,changed);
    window.addEventListener('storage',changed);
    return()=>{window.removeEventListener(THEME_CHANGED_EVENT,changed);window.removeEventListener('storage',changed);};
  },[]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    if (name === "theme_preference") {
      if (!isThemePreference(value)) {
        return;
      }

      setFormData(prev => ({ ...prev, theme_preference: value }));
      persistThemePreference(value);
      applyThemePreference(value);
      return;
    }

    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if(saving.current)return;
    const draft={...formData};
    if(!loaded||!preferencesReady(draft)){setError('Choose valid explicit preference values before saving.');return;}
    saving.current=true;setLoading(true);setError(null);setSuccess(false);
    let acknowledged=false;
    try {
      await apiService.updateProfile(draft);acknowledged=true;
      if(!alive.current)return;
      const verified=savedPreferences(await apiService.getProfile());
      if(!alive.current)return;
      if(!preferencesReady(verified))throw new Error('Saved values are unverified');
      setFormData(verified);
      persistThemePreference(verified.theme_preference);applyThemePreference(verified.theme_preference);
      if(JSON.stringify(verified)!==JSON.stringify(draft)){setError('Server preferences differ from this submitted draft. Review these current values before another deliberate save.');return;}
      setSuccess(true);
    } catch {
      if(alive.current){setLoaded(false);setReadError(acknowledged?'Your update was accepted, but saved preferences could not be verified. Reload before another save.':'The preference update outcome is unverified. Reload saved preferences before another save.');}
    } finally {
      saving.current=false;if(alive.current)setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Preferences</h3>
        <p className="text-sm text-muted-foreground">
          Update your application settings.
        </p>
      </div>
      <Separator />
      
      {success && (
        <FormAlert
          type="success"
          title="Preferences Updated"
          message="Your preferences have been successfully updated."
          onDismiss={() => setSuccess(false)}
        />
      )}
      
      {error && (
        <FormAlert
          type="error"
          title="Update Failed"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      {!loaded&&!readError&&<p role="status">Loading saved ordinary preferences…</p>}
      {readError&&<div role="alert" className="space-y-3 rounded-lg border p-3"><p>{readError}</p><button type="button" className="underline" onClick={()=>setReload(value=>value+1)}>Reload saved preferences</button></div>}
      {loaded&&!preferencesReady(formData)&&<p role="status">Some saved preferences are missing or unsupported. Choose explicit values before saving.</p>}
      <form onSubmit={handleSubmit}><fieldset disabled={!loaded||loading} className="space-y-8">
        <div className="space-y-2">
          <Label htmlFor="theme_preference">Theme</Label>
          <select
            id="theme_preference"
            name="theme_preference"
            value={formData.theme_preference}
            onChange={handleChange}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">Choose a theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
          <p className="text-[0.8rem] text-muted-foreground">
            Select the theme for the dashboard.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="timezone">Timezone</Label>
          <select
            id="timezone"
            name="timezone"
            value={formData.timezone}
            onChange={handleChange}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">Choose a time zone</option>
            {timezones.map(([value,label])=><option key={value} value={value}>{label}</option>)}
            {recordedTimeZone(formData.timezone)&&!timezones.some(([value])=>value===formData.timezone)&&<option value={formData.timezone}>Saved: {formData.timezone}</option>}
          </select>
        </div>

        <div id="notification-settings" className="space-y-2">
          <p className="text-sm">These preferences choose notification categories; they are not proof of delivery. External email/WhatsApp delivery is disabled in UAT2. Changing a preference never approves orders or restarts research.</p>
          <Label htmlFor="notification_preferences">Notifications</Label>
          <select
            id="notification_preferences"
            name="notification_preferences"
            value={formData.notification_preferences}
            onChange={handleChange}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">Choose notification categories</option>
            <option value="all">All notifications</option>
            <option value="important">Important only</option>
            <option value="none">None</option>
          </select>
        </div>

        <Button type="submit" disabled={loading||!loaded||!preferencesReady(formData)} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          {loading ? "Saving..." : "Update preferences"}
        </Button>
      </fieldset></form>
      <ModulePreferences />
    </div>
  );
}
