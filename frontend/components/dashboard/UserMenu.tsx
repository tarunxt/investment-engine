import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, User, Settings, LogOut, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { URLs } from '@/lib/urls';

interface User {
  full_name?: string;
  username?: string;
  email?: string;
  avatar?: string;
}

interface UserMenuProps {
  user: User | null;
  onLogout: () => void;
  className?: string;
}

export const UserMenu: React.FC<UserMenuProps> = ({ user, onLogout, className }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      // Prevent body scroll when menu is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const getInitials = () => {
    if (user?.full_name) {
      return user.full_name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return user?.username?.[0]?.toUpperCase() || 'U';
  };

  const displayName = user?.full_name || user?.username || 'User';

  return (
    <div className={cn("relative", className)} ref={menuRef}>
      <Button
        variant="outline"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center space-x-3 px-4 h-10 rounded-sm",
          "hover:bg-gray-100 transition-colors duration-200",
          isOpen && "bg-gray-100"
        )}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        {user?.avatar ? (
          <img 
            src={user.avatar} 
            alt={displayName}
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <div className="h-8 w-8 rounded-full bg-linear-to-r from-indigo-600 to-purple-600 flex items-center justify-center text-white font-semibold text-sm">
            {getInitials()}
          </div>
        )}
        <span className="hidden md:block text-sm font-medium text-gray-700">
          {displayName}
        </span>
        <ChevronDown 
          className={cn(
            "hidden md:block h-4 w-4 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </Button>

      {isOpen && (
        <div 
          className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg py-1 z-20 border border-gray-200 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200"
          role="menu"
          aria-orientation="vertical"
        >
          {/* User info section */}
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900 truncate">
              {displayName}
            </p>
            {user?.email && (
              <p className="text-xs text-gray-500 truncate mt-0.5 flex items-center gap-1">
                <Mail className="h-3 w-3 shrink-0" />
                <span className="truncate">{user.email}</span>
              </p>
            )}
          </div>

          {/* Menu items */}
          <div className="py-1">
            <Link
              href={URLs.routes.profile.root()}
              className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-150"
              onClick={() => setIsOpen(false)}
            >
              <User className="mr-3 h-4 w-4 text-gray-400" />
              Your Profile
            </Link>
            
            <Link
              href={URLs.routes.profile.preferences()}
              className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-150"
              onClick={() => setIsOpen(false)}
            >
              <Settings className="mr-3 h-4 w-4 text-gray-400" />
              Preferences
            </Link>
            
            <hr className="my-1 border-gray-100" />
            
            <button
              onClick={() => {
                setIsOpen(false);
                onLogout();
              }}
              className="flex w-full items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors duration-150"
            >
              <LogOut className="mr-3 h-4 w-4 text-red-500" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};