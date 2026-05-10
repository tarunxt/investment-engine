"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";
import { apiService } from "@/services/api";
import { FormAlert } from "@/components/auth/FormAlert";

export default function ProfilePage() {
  const { user, refreshAuth } = useAuth();
  
  const [loading, setLoading] = useState(false);
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
    async function loadProfile() {
      if (!user) return;
      
      setFormData(prev => ({
        ...prev,
        username: user.username || "",
        email: user.email || "",
        full_name: user.full_name || "",
      }));

      try {
        const profile = await apiService.getProfile();
        setFormData(prev => ({
          ...prev,
          bio: profile.bio || "",
          avatar_url: profile.avatar_url || "",
        }));
      } catch (err) {
        console.error("Failed to load profile:", err);
      }
    }
    loadProfile();
  }, [user]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await apiService.updateProfile({
        full_name: formData.full_name,
        bio: formData.bio,
        avatar_url: formData.avatar_url,
      });
      // Refresh auth context to update user name
      if (user) {
         await refreshAuth();
      }
      setSuccess(true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to update profile";
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Profile</h3>
        <p className="text-sm text-muted-foreground">
          This is how others will see you on the site.
        </p>
      </div>
      <Separator />
      
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

      <form onSubmit={handleSubmit} className="space-y-8">
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
      </form>
    </div>
  );
}
