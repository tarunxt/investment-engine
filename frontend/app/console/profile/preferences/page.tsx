"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { apiService } from "@/services/api";
import { FormAlert } from "@/components/auth/FormAlert";

export default function PreferencesPage() {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    timezone: "UTC",
    notification_preferences: "all",
    theme_preference: "light",
  });

  useEffect(() => {
    async function loadPreferences() {
      try {
        const profile = await apiService.getProfile();
        setFormData({
          timezone: profile.timezone || "UTC",
          notification_preferences: profile.notification_preferences || "all",
          theme_preference: profile.theme_preference || "light",
        });
      } catch (err) {
        console.error("Failed to load preferences:", err);
      }
    }
    loadPreferences();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
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
        timezone: formData.timezone,
        notification_preferences: formData.notification_preferences,
        theme_preference: formData.theme_preference,
      });
      setSuccess(true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to update preferences";
      setError(errorMsg);
    } finally {
      setLoading(false);
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

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="space-y-2">
          <Label htmlFor="theme_preference">Theme</Label>
          <select
            id="theme_preference"
            name="theme_preference"
            value={formData.theme_preference}
            onChange={handleChange}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
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
            <option value="UTC">UTC</option>
            <option value="America/New_York">Eastern Time (US & Canada)</option>
            <option value="America/Chicago">Central Time (US & Canada)</option>
            <option value="America/Denver">Mountain Time (US & Canada)</option>
            <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
            <option value="Europe/London">London</option>
            <option value="Europe/Paris">Paris</option>
            <option value="Asia/Tokyo">Tokyo</option>
            <option value="Asia/Calcutta">India Standard Time</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="notification_preferences">Notifications</Label>
          <select
            id="notification_preferences"
            name="notification_preferences"
            value={formData.notification_preferences}
            onChange={handleChange}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="all">All notifications</option>
            <option value="important">Important only</option>
            <option value="none">None</option>
          </select>
        </div>

        <Button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          {loading ? "Saving..." : "Update preferences"}
        </Button>
      </form>
    </div>
  );
}
