import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { getDemoMediaBlob } from '../../services/demoMediaDb';
import { useAuth } from '../../context/AuthContext';

export const PRAGYA_MEDIA_CACHE_NAME = 'pragya-media-v1';

export interface DriveImageProps {
  attachment: Extract<Attachment, { type: 'image' }>;
  alt?: string;
  className?: string;
  onClick?: () => void;
  testId?: string;
}

export const DriveImage: React.FC<DriveImageProps> = ({
  attachment,
  alt,
  className = '',
  onClick,
  testId,
}) => {
  const { getGoogleToken, triggerSessionExpired } = useAuth();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    const loadImage = async () => {
      setFailed(false);
      setSrc(null);

      try {
        if (attachment.demoMediaId) {
          const blob = await getDemoMediaBlob(attachment.demoMediaId);
          if (!active) return;
          if (!blob) {
            setFailed(true);
            return;
          }
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        }

        if (attachment.driveFileId) {
          const cacheKey = `https://pragya.local/drive-media/${encodeURIComponent(
            attachment.driveFileId
          )}`;

          let blob: Blob | null = null;

          if (typeof caches !== 'undefined') {
            try {
              const cache = await caches.open(PRAGYA_MEDIA_CACHE_NAME);
              const cachedResponse = await cache.match(cacheKey);
              if (cachedResponse) {
                blob = await cachedResponse.blob();
              }
            } catch {
              // Cache API unavailable or restricted
            }
          }

          if (!blob) {
            const token = getGoogleToken();
            if (!token) {
              setFailed(true);
              return;
            }
            const res = await fetch(
              `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
                attachment.driveFileId
              )}?alt=media`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              }
            );

            if (res.status === 401) {
              triggerSessionExpired();
              if (active) setFailed(true);
              return;
            }

            if (!res.ok) {
              if (active) setFailed(true);
              return;
            }

            const cloned = res.clone();
            blob = await res.blob();

            if (typeof caches !== 'undefined') {
              try {
                const cache = await caches.open(PRAGYA_MEDIA_CACHE_NAME);
                await cache.put(cacheKey, cloned);
              } catch {
                // Ignore cache write errors
              }
            }
          }

          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        }

        setFailed(true);
      } catch {
        if (active) setFailed(true);
      }
    };

    void loadImage();

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachment.demoMediaId, attachment.driveFileId, getGoogleToken, triggerSessionExpired]);

  if (failed) {
    return (
      <div
        data-testid={testId}
        className={`flex items-center justify-center bg-surface2 border border-border text-muted-foreground rounded-[10px] ${className}`}
      >
        <div className="flex flex-col items-center gap-1 p-2 text-center">
          <ImageOff className="w-4 h-4" />
          <span className="text-[11px] truncate max-w-[120px]">{attachment.fileName}</span>
        </div>
      </div>
    );
  }

  if (!src) {
    return (
      <div
        data-testid={testId}
        className={`animate-pulse bg-surface2 border border-border rounded-[10px] ${className}`}
      />
    );
  }

  return (
    <img
      data-testid={testId}
      src={src}
      alt={alt ?? attachment.fileName}
      onClick={onClick}
      className={`${className} ${onClick ? 'cursor-zoom-in' : ''}`}
    />
  );
};
