'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export default function ClientLogger() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  useEffect(() => {
    const url = `${pathname}${searchParams?.toString() ? `?${searchParams.toString()}` : ''}`;
    console.log('=== Client-side Navigation ===');
    console.log('Current URL:', url);
    console.log('Full URL:', window.location.href);
    console.log('Pathname:', pathname);
    console.log('Search params:', searchParams?.toString());
    console.log('Cookies:', document.cookie);
  }, [pathname, searchParams]);
  
  return null;
}