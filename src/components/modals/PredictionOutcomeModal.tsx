import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragyaActions } from '../../context/PragyaContext';
import { formatChapterPos } from '../../utils/chapterFormat';
import { describeSyncError } from '../../utils/apiErrors';
import { isSubmitShortcut } from '../../utils/keyboard';
import { NOTE_PREDICTION_OUTCOME_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SIZE_LG, FIELD_LABEL, INSET, TEXTAREA } from '../common/uiClasses';

export interface PredictionOutcomeModalProps {
  note: Note | null;
  book: Book | null;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * CD C4.2 (ux_spec_cd C.4.5): "How did it play out?" for an unlocked fiction prediction.
 * Stored only in `note.meta.predictionOutcome = { text, at }` (no column change); the save
 * owns just that key so concurrent meta (sparStage, chapter, …) is never clobbered.
 */
export function PredictionOutcomeModal({ note, book, isOpen, onClose }: PredictionOutcomeModalProps) {
  const { updateNote } = usePragyaActions();
  const headingId = useId();
  const fieldId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen && note) {
      setText(note.meta?.predictionOutcome?.text || '');
      setSaving(false);
    }
  }, [isOpen, note]);

  if (!note || !book) return null;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const trimmed = text.trim();
      const meta = { ...note.meta };
      if (trimmed) meta.predictionOutcome = { text: trimmed, at: new Date().toISOString() };
      else delete meta.predictionOutcome;
      await updateNote(
        { ...note, meta },
        {
          expectedBaseUpdatedAt: note.updatedAt,
          ownedMetaKeys: NOTE_PREDICTION_OUTCOME_OWNED_META_KEYS,
          baseMeta: note.meta,
        }
      );
      showToast('Saved your reflection.', 'success');
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to save reflection'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="prediction-outcome-modal"
      title="How did it play out?"
      headingId={headingId}
      maxWidth="max-w-lg"
      initialFocusRef={textareaRef}
    >
      <form
        className="space-y-4"
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={e => {
          if (isSubmitShortcut(e.nativeEvent)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={headingId} className="text-title text-foreground">
              How did it play out?
            </h2>
            <p className="text-label text-muted-foreground truncate">
              {book.title} · your prediction at{' '}
              {formatChapterPos(note.meta?.chapter, Number(note.pos) || 0, book.posUnit)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1.5 rounded-[8px] inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className={`${INSET} text-body text-foreground whitespace-pre-wrap`}>{note.takeaway}</p>
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className={FIELD_LABEL}>
            What actually happened, and what you noticed
          </label>
          <textarea
            id={fieldId}
            ref={textareaRef}
            rows={4}
            data-testid="prediction-outcome-input"
            value={text}
            onChange={e => setText(e.target.value)}
            className={TEXTAREA}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${BTN_SECONDARY} ${BTN_SIZE_LG}`}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            data-testid="prediction-outcome-save-btn"
            className={`${BTN_PRIMARY} ${BTN_SIZE_LG}`}
          >
            Save Reflection
          </button>
        </div>
      </form>
    </Modal>
  );
}
