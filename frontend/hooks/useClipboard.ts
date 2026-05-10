// hooks/useClipboard.ts
import { useState, useCallback } from 'react';

interface UseClipboardReturn {
    copy: (text: string) => Promise<boolean>;
    copied: boolean;
    error: Error | null;
}

export function useClipboard(): UseClipboardReturn {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const copy = useCallback(async (text: string): Promise<boolean> => {
        setCopied(false);
        setError(null);

        try {
            // Try modern clipboard API
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
                return true;
            }

            // Fallback method
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            const success = document.execCommand('copy');
            document.body.removeChild(textArea);

            if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
                return true;
            } else {
                throw new Error('Copy command failed');
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error('Failed to copy');
            setError(error);
            console.error('Clipboard error:', error);
            return false;
        }
    }, []);

    return { copy, copied, error };
}