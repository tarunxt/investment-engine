"use client";

import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export function LazyMount({
  children,
  fallback = null,
  minHeight = 1,
  rootMargin = "400px",
  onVisible,
  deferUntilScroll = false,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  minHeight?: number;
  rootMargin?: string;
  onVisible?: () => void;
  deferUntilScroll?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [scrollObserved, setScrollObserved] = useState(!deferUntilScroll);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const onVisibleRef = useRef(onVisible);

  useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    if (scrollObserved) return;
    const handleScroll = () => setScrollObserved(true);
    window.addEventListener("scroll", handleScroll, {
      once: true,
      passive: true,
    });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [scrollObserved]);

  useEffect(() => {
    if (!scrollObserved) return;
    const marker = markerRef.current;
    if (!marker || visible) return;

    if (!("IntersectionObserver" in window)) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setVisible(true);
        onVisibleRef.current?.();
      });
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        onVisibleRef.current?.();
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [rootMargin, scrollObserved, visible]);

  if (visible) return children;

  return (
    <div ref={markerRef} style={{ minHeight }}>
      {fallback}
    </div>
  );
}
