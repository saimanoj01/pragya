import React, { useState } from 'react';
import type { Attachment } from '../../types/pragya';
import { DriveImage } from './DriveImage';
import { ImageLightbox } from '../modals/ImageLightbox';

export interface StreamThumbnailProps {
  attachment: Extract<Attachment, { type: 'image' }>;
  className?: string;
}

/**
 * CD D1.2 / ux_spec_cd §D.1.4: a stream-card image thumbnail is a button that opens the shared
 * ImageLightbox (focus returns to the thumbnail on close). Callers never render it for a
 * shielded note — the thumbnail is part of the hidden content.
 */
export const StreamThumbnail: React.FC<StreamThumbnailProps> = ({ attachment, className = '' }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-print-keep="true"
        data-testid={`stream-thumb-btn-${attachment.id}`}
        aria-label={`View image ${attachment.fileName || 'attachment'}`}
        onClick={() => setOpen(true)}
        className="min-w-11 min-h-11 shrink-0 inline-flex items-center justify-center rounded-[8px] cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <DriveImage attachment={attachment} alt="" className={className} />
      </button>
      <ImageLightbox attachment={open ? attachment : null} onClose={() => setOpen(false)} />
    </>
  );
};
