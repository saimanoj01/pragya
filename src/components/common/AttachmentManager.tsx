import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Link2, Loader2, X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { describeSyncError } from '../../utils/apiErrors';
import {
  HTTP_URL_REGEX,
  MAX_RENDERABLE_ATTACHMENTS,
  appendAttachmentUnderCap,
  isAttachmentSubformEnter,
  isAtAttachmentLimit,
  isTextPasteTarget,
  parseUrlAttachmentInput,
} from '../../utils/attachmentLimits';
import { OPEN_DIALOG_SELECTOR, isTopmostOpenDialog } from '../../utils/dialogOverlay';
import { createUuid } from '../../utils/sessionCoalesce';
import { showToast } from '../../utils/toast';
import { DriveImage } from './DriveImage';
import { EYEBROW } from './uiClasses';

export interface AttachmentManagerProps {
  isOpen: boolean;
  attachments: Attachment[];
  onChange: React.Dispatch<React.SetStateAction<Attachment[]>>;
  uploadImageAttachment: (file: File | Blob) => Promise<Attachment>;
  resolveDocTitle: (docId: string) => Promise<string | null>;
  onUploadingChange?: (uploading: boolean) => void;
  /** Prefix for `data-testid`s (e.g. `'capture'` → `capture-attach-photo-btn`, `capture-attachment-list`). */
  testIdPrefix?: string;
  resetKey?: string | number;
}

/**
 * CD Batch 5 (D3.1 + QA-43 / R1#3 / R2-3): shared Photo / Doc / Link attachment bar, inline URL
 * subform, modal-level Cmd/Ctrl+V paste handler (scoped to topmost open dialog), session-epoch
 * async guards, 3/3 cap, and removable attachment chip list.
 */
export const AttachmentManager: React.FC<AttachmentManagerProps> = ({
  isOpen,
  attachments,
  onChange,
  uploadImageAttachment,
  resolveDocTitle,
  onUploadingChange,
  testIdPrefix,
  resetKey,
}) => {
  const [attachMode, setAttachMode] = useState<'none' | 'doc' | 'link'>('none');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionEpochRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const tid = (suffix: string) => (testIdPrefix ? `${testIdPrefix}-${suffix}` : undefined);
  const isCaptureVariant = testIdPrefix === 'capture';
  const atLimit = isAtAttachmentLimit(attachments);

  const setUploading = useCallback(
    (next: boolean) => {
      setUploadingImage(next);
      onUploadingChange?.(next);
    },
    [onUploadingChange]
  );

  useEffect(() => {
    sessionEpochRef.current += 1;
    setAttachMode('none');
    setDraftUrl('');
    setDraftTitle('');
    setUploading(false);
  }, [isOpen, resetKey, setUploading]);

  const attachUrl = useCallback(
    async (rawUrl: string, explicitTitle?: string): Promise<boolean> => {
      const parsed = parseUrlAttachmentInput(rawUrl, explicitTitle);
      if (!parsed.ok) {
        showToast(parsed.error, 'error');
        return false;
      }
      if (isAtAttachmentLimit(attachments)) {
        showToast(`Maximum ${MAX_RENDERABLE_ATTACHMENTS} attachments per note`, 'error');
        return false;
      }

      if (parsed.kind === 'doc') {
        const attId = createUuid();
        const epoch = sessionEpochRef.current;
        onChange(prev =>
          appendAttachmentUnderCap(prev, {
            id: attId,
            type: 'doc',
            title: parsed.title,
            url: parsed.url,
            docId: parsed.docId,
          }).attachments
        );
        if (parsed.needsTitleResolve) {
          resolveDocTitle(parsed.docId)
            .then(resolved => {
              if (!resolved || !isOpenRef.current || sessionEpochRef.current !== epoch) return;
              onChange(prev =>
                prev.map(a => (a.id === attId && a.type === 'doc' ? { ...a, title: resolved } : a))
              );
            })
            .catch(() => {});
        }
        return true;
      }

      onChange(prev =>
        appendAttachmentUnderCap(prev, {
          id: createUuid(),
          type: 'link',
          title: parsed.title,
          url: parsed.url,
        }).attachments
      );
      return true;
    },
    [attachments, onChange, resolveDocTitle]
  );

  const handleImageFile = useCallback(
    async (file: File | Blob) => {
      if (isAtAttachmentLimit(attachments)) {
        showToast(`Maximum ${MAX_RENDERABLE_ATTACHMENTS} attachments per note`, 'error');
        return;
      }
      const epoch = sessionEpochRef.current;
      setUploading(true);
      try {
        const uploaded = await uploadImageAttachment(file);
        if (!isOpenRef.current || sessionEpochRef.current !== epoch) return;
        onChange(prev => {
          const res = appendAttachmentUnderCap(prev, uploaded);
          if (!res.added) {
            showToast(`Maximum ${MAX_RENDERABLE_ATTACHMENTS} attachments per note`, 'error');
          }
          return res.attachments;
        });
      } catch (err) {
        if (!isOpenRef.current || sessionEpochRef.current !== epoch) return;
        showToast(describeSyncError(err, 'Failed to compress/attach image'), 'error');
      } finally {
        if (isOpenRef.current && sessionEpochRef.current === epoch) {
          setUploading(false);
        }
      }
    },
    [attachments, onChange, setUploading, uploadImageAttachment]
  );

  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      // R1#3 / R2-3 / CD Batch 6: ignore paste when a stacked dialog (e.g. ConfirmDialog) sits above this modal.
      const myDialog = fileInputRef.current?.closest(OPEN_DIALOG_SELECTOR) ?? null;
      if (myDialog && !isTopmostOpenDialog(myDialog, document)) {
        return;
      }

      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              void handleImageFile(file);
              return;
            }
          }
        }
      }

      const text = e.clipboardData?.getData('text/plain')?.trim() || '';
      if (text && HTTP_URL_REGEX.test(text)) {
        const active = document.activeElement as HTMLElement | null;
        const inputType =
          active?.tagName === 'INPUT' ? (active as HTMLInputElement).type : undefined;
        const editable = Boolean(
          active?.isContentEditable || active?.closest?.('[contenteditable="true"]')
        );
        if (!isTextPasteTarget(active?.tagName, inputType, editable)) {
          e.preventDefault();
          void attachUrl(text).then(ok => {
            if (ok) {
              setAttachMode('none');
              setDraftUrl('');
              setDraftTitle('');
            }
          });
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [attachUrl, handleImageFile, isOpen]);

  const handleConfirmUrl = async () => {
    const ok = await attachUrl(draftUrl, draftTitle);
    if (ok) {
      setAttachMode('none');
      setDraftUrl('');
      setDraftTitle('');
    }
  };

  const handleSubformKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isAttachmentSubformEnter(e.nativeEvent)) {
      e.preventDefault();
      void handleConfirmUrl();
    }
  };

  const attachBtnClass =
    'h-11 sm:h-8 px-3 sm:px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors';

  return (
    <div className="space-y-2 pt-2 border-t border-border/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`${EYEBROW} num`}>
          Attachments ({attachments.length}/{MAX_RENDERABLE_ATTACHMENTS})
        </span>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            aria-label="Upload image attachment"
            data-testid={tid('photo-input')}
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                void handleImageFile(file);
              }
              e.target.value = '';
            }}
          />

          <button
            type="button"
            data-testid={tid('attach-photo-btn')}
            disabled={atLimit || uploadingImage}
            onClick={() => fileInputRef.current?.click()}
            className={attachBtnClass}
          >
            {uploadingImage ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ImageIcon className="w-3.5 h-3.5" />
            )}
            <span>Photo</span>
          </button>

          <button
            type="button"
            data-testid={tid('attach-doc-btn')}
            disabled={atLimit}
            onClick={() => {
              setAttachMode(prev => (prev === 'doc' ? 'none' : 'doc'));
              setDraftUrl('');
              setDraftTitle('');
            }}
            className={attachBtnClass}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Doc</span>
          </button>

          <button
            type="button"
            data-testid={tid('attach-link-btn')}
            disabled={atLimit}
            onClick={() => {
              setAttachMode(prev => (prev === 'link' ? 'none' : 'link'));
              setDraftUrl('');
              setDraftTitle('');
            }}
            className={attachBtnClass}
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>Link</span>
          </button>
        </div>
      </div>

      {attachMode !== 'none' && (
        <div className="p-3 rounded-[10px] bg-surface2/50 border border-border flex flex-col sm:flex-row gap-2">
          <input
            type="url"
            aria-label="Attachment URL"
            data-testid={tid('attachment-url-input')}
            value={draftUrl}
            onChange={e => setDraftUrl(e.target.value)}
            onKeyDown={handleSubformKeyDown}
            placeholder={
              attachMode === 'doc'
                ? 'Paste Google Doc URL (https://docs.google.com/document/d/...)'
                : 'Paste reference URL (https://...)'
            }
            className="flex-1 h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <input
            type="text"
            enterKeyHint="done"
            aria-label="Attachment title"
            data-testid={tid('attachment-title-input')}
            value={draftTitle}
            onChange={e => setDraftTitle(e.target.value)}
            onKeyDown={handleSubformKeyDown}
            placeholder="Title (optional)"
            className="sm:w-40 h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="button"
            data-testid={tid('attachment-confirm-btn')}
            onClick={() => void handleConfirmUrl()}
            className="h-11 sm:h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
          >
            Attach
          </button>
        </div>
      )}

      {(isCaptureVariant || attachments.length > 0) && (
        <div data-testid={tid('attachment-list')} className="space-y-1.5">
          {attachments.map(att => {
            const label = att.type === 'image' ? att.fileName : att.title;
            return (
              <div
                key={att.id}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[8px] bg-surface2 border border-border text-label"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {att.type === 'image' ? (
                    <DriveImage
                      attachment={att}
                      className="w-8 h-8 rounded object-cover shrink-0 border border-border"
                    />
                  ) : att.type === 'doc' ? (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate font-medium text-foreground">{label}</span>
                  {isCaptureVariant && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-background text-muted-foreground border border-border shrink-0">
                      {att.type}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={isCaptureVariant ? 'Remove attachment' : `Remove ${label}`}
                  onClick={() => onChange(prev => prev.filter(a => a.id !== att.id))}
                  className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1 inline-flex items-center justify-center text-muted-foreground hover:text-negative transition-colors shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
