'use client';

import { Search } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDashboard } from '../_context';

export function TemplateField() {
  const {
    promptTemplates,
    selectedTemplateId,
    templateSearch,
    handleTemplateSearch,
    handleTemplateChange,
  } = useDashboard();

  return (
    <div className="space-y-2">
      <Label htmlFor="template-search">Template</Label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" />
        <input
          id="template-search"
          type="text"
          value={templateSearch}
          onChange={(e) => handleTemplateSearch(e.target.value)}
          placeholder="Search prompts…"
          className="w-full border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-950 outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10"
        />
      </div>
      {promptTemplates.length > 0 ? (
        <Select value={selectedTemplateId} onValueChange={handleTemplateChange}>
          <SelectTrigger id="template" className="w-full border-gray-300 px-3">
            <SelectValue placeholder="Load a saved template…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {promptTemplates.map((tpl) => (
              <SelectItem key={tpl.id} value={String(tpl.id)}>
                {tpl.name}
                <span className="ml-2 text-xs text-gray-400">
                  {tpl.is_system ? 'System' : 'User'}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : templateSearch ? (
        <p className="text-xs text-gray-400">No prompts match &ldquo;{templateSearch}&rdquo;</p>
      ) : null}
    </div>
  );
}
