"use client";

import { useEffect, useRef, useState } from "react";
import {useSession} from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";
import { apiService } from "@/services/api";
import { FormAlert } from "@/components/auth/FormAlert";
import {recordedTimeZone} from '@/lib/conceptFProfile';
import {ConceptFProfile} from '@/components/workspace/ConceptFProfile';

export default function ProfilePage(){
  const {data:session,status}=useSession();const {user}=useAuth();
  if(status!=='authenticated'||!user||String(user.id)!==String(session?.user?.id))return <p role="status">Verifying your private profile…</p>;
  return <OwnedProfilePage key={`${user.id}:${session?.generation}`}/>;
}
function OwnedProfilePage() {
  const { user } = useAuth();
  
  const [loading, setLoading] = useState(false);
  const [profileState,setProfileState]=useState<'loading'|'ready'|'failed'>('loading');
  const [profileReload,setProfileReload]=useState(0);
  const saving=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const [savedName,setSavedName]=useState<string|null>(null);
  const [timeZone,setTimeZone]=useState<string|null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    full_name: "",
    bio: "",
    avatar_url: "",
  });

  // Load profile data on mount
  useEffect(() => {
    let active=true;
    async function loadProfile() {
      if (!user) return;
      setTimeZone(null);
      setProfileState('loading');
      
      setFormData(prev => ({
        ...prev,
        username: user.username || "",
        email: user.email || "",
        full_name: user.full_name || "",
      }));

      try {
        const profile = await apiService.getProfile();
        if(!active)return;
        setTimeZone(recordedTimeZone(profile.timezone));
        setProfileState('ready');
        setSavedName(profile.full_name??null);
        setError(null);
        setFormData(prev => ({
          ...prev,
          full_name:profile.full_name||"",
          bio: profile.bio || "",
          avatar_url: profile.avatar_url || "",
        }));
      } catch (err) {
        if(active)setProfileState('failed');
      }
    }
    loadProfile();
    return()=>{active=false;};
  }, [user,profileReload]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if(profileState!=='ready'||saving.current)return;
    saving.current=true;
    setLoading(true);
    setError(null);
    setSuccess(false);

    const draft={full_name:formData.full_name,bio:formData.bio,avatar_url:formData.avatar_url};
    let acknowledged=false;
    try {
      await apiService.updateProfile(draft);
      acknowledged=true;
      if(!alive.current)return;
      const verified=await apiService.getProfile();
      if(!alive.current)return;
      setSavedName(verified.full_name??null);
      setTimeZone(recordedTimeZone(verified.timezone));
      setFormData(previous=>({...previous,full_name:verified.full_name||"",bio:verified.bio||"",avatar_url:verified.avatar_url||""}));
      if(verified.full_name!==draft.full_name||(verified.bio??'')!==draft.bio||(verified.avatar_url??'')!==draft.avatar_url){
        setError('Saved profile fields differ from this submitted draft. Review these current values before another deliberate update.');
        return;
      }
      if(alive.current)setSuccess(true);
    } catch (err) {
      if(alive.current){
        setProfileState('failed');
        setError(acknowledged?'Your update was accepted, but saved fields could not be verified. Reload saved profile before another edit.':'The profile update outcome is unverified. Reload saved profile before another edit.');
      }
    } finally {
      saving.current=false;
      if(alive.current)setLoading(false);
    }
  };

  const editor = (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Profile</h3>
        <p className="text-sm text-muted-foreground">
          Your private workspace profile. Changing these details does not change your sign-in identity or connected brokerage account.
        </p>
      </div>
      <Separator />
      {process.env.NEXT_PUBLIC_UAT2!=='true'&&profileState==='loading'&&<p role="status">Loading saved profile fields… Editing is paused.</p>}
      {process.env.NEXT_PUBLIC_UAT2!=='true'&&profileState==='failed'&&<div role="alert"><p>Saved profile fields could not be verified. Editing is paused.</p><button type="button" onClick={()=>setProfileReload(value=>value+1)}>Reload saved profile</button></div>}
      
      {success && (
        <FormAlert
          type="success"
          title="Profile Updated"
          message="Your profile has been successfully updated."
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

      <form onSubmit={handleSubmit}><fieldset disabled={profileState!=='ready'||loading} className="space-y-8">
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            value={formData.username}
            disabled
            className="bg-muted"
          />
          <p className="text-[0.8rem] text-muted-foreground">
            This is your public display name. It cannot be changed.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            value={formData.email}
            disabled
            className="bg-muted"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="full_name">Full Name</Label>
          <Input
            id="full_name"
            name="full_name"
            value={formData.full_name}
            onChange={handleChange}
            placeholder="Your name"
          />
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="avatar_url">Avatar URL</Label>
          <Input
            id="avatar_url"
            name="avatar_url"
            value={formData.avatar_url}
            onChange={handleChange}
            placeholder="https://example.com/avatar.jpg"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bio">Bio</Label>
          <textarea
            id="bio"
            name="bio"
            value={formData.bio}
            onChange={handleChange}
            placeholder="Tell us a little bit about yourself"
            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <Button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          {loading ? "Saving..." : "Update profile"}
        </Button>
      </fieldset></form>
    </div>
  );
  return process.env.NEXT_PUBLIC_UAT2==='true'?<ConceptFProfile user={user&&profileState==='ready'?{...user,full_name:savedName??undefined}:user} editor={editor} timeZone={timeZone} profileState={profileState} onRetry={()=>setProfileReload(value=>value+1)}/>:editor;
}
