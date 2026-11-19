import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Link2 } from 'lucide-react';
import type { Attachment, Note } from '../../types/pragya';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl } from '../../utils/navigation';
import { ImageLightbox } from '../modals/ImageLightbox';
import { DriveImage } from './DriveImage';

export interface DeepenSourceReferenceProps {
  note: Note;
}

/**
 * Collapsible source passage + attachments preview with ImageLightbox inside DeepenNoteModal.
 */
export const DeepenSourceReference: React.FC<DeepenSourceReferenceProps> = ({ note }) => {
  const [showSourceRef, setShowSourceRef] = useState(true);
  const [lightboxAtt, setLightboxAtt] = useState<Extract<Attachment, { type: 'image' }> | null>(
    null
  );

  useEffect(() => {
    setShowSourceRef(true);
    setLightboxAtt(null);
  }, [note.id]);

  const sourceAttachments = getRenderableAttachments(note.meta);
  const hasSourceReference = Boolean(note.quote?.trim()) || sourceAttachments.length > 0;
  if (!hasSourceReference) return null;

  return (
    <>
      <div
        data-testid="deepen-source-reference"
        className="mb-4 rounded-[12px] bg-surface2/50 border border-border overflow-hidden"
      >
        <button
          type="button"
          data-testid="deepen-source-toggle"
          aria-expanded={showSourceRef}
          onClick={() => setShowSourceRef(prev => !prev)}
          className="w-full min-h-11 px-4 py-2.5 flex items-center justify-between gap-2 text-left text-eyebrow uppercase text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>
            Source Passage
            {sourceAttachments.length > 0 ? ` & Attachments (${sourceAttachments.length})` : ''}
          </span>
          {showSourceRef ? (
            <ChevronUp className="w-4 h-4 shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 shrink-0" />
          )}
        </button>

        {showSourceRef && (
          <div className="px-4 pb-3.5 pt-1 space-y-3 border-t border-border/50">
            {note.quote?.trim() && (
              <blockquote
                data-testid="deepen-source-quote"
                className="pl-3 border-l-2 border-border italic text-body text-muted-foreground whitespace-pre-wrap"
              >
                &ldquo;{note.quote}&rdquo;
              </blockquote>
            )}

            {sourceAttachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {sourceAttachments.map(att =>
                  att.type === 'image' ? (
                    <button
                      key={att.id}
                      type="button"
                      data-testid={`deepen-attachment-image-${att.id}`}
                      aria-label={`Preview ${att.fileName}`}
                      onClick={() => setLightboxAtt(att)}
                      className="rounded-[8px] border border-border overflow-hidden hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <DriveImage
                        attachment={att}
                        alt=""
                        className="w-16 h-16 object-cover"
                      />
                    </button>
                  ) : isSafeHttpUrl(att.url) ? (
                    <a
                      key={att.id}
                      href={att.url.trim()}
                      data-print-href={att.url.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background border border-border text-label text-foreground hover:bg-surface2"
                    >
                      {att.type === 'doc' ? (
                        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="truncate max-w-[180px]">{att.title}</span>
                    </a>
                  ) : (
                    <span
                      key={att.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background border border-border text-label text-muted-foreground"
                    >
                      <Link2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[180px]">{att.title}</span>
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ImageLightbox attachment={lightboxAtt} onClose={() => setLightboxAtt(null)} />
    </>
  );
};
