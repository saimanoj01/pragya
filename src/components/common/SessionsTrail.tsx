import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Edit3, Plus } from 'lucide-react';
import type { Book, ReadingSession } from '../../types/pragya';
import { usePragyaActions, usePragyaData } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import {
  SESSIONS_TRAIL_LIMIT,
  SESSION_NOTE_MAX,
  bookSessionsNewestFirst,
  sessionDateLabel,
} from '../../utils/bookSurfaces';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { formatPosDisplay } from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { BTN_SECONDARY, BTN_TERTIARY, EYEBROW, HELPER, INPUT } from './uiClasses';

/**
 * CD C2.3 (ux_spec_cd C.2.1, decisions OQ-1 override): optional per-session note editor
 * (Sessions!G, ≤ 280 chars). Enter saves, Esc cancels. No stitching into capstone,
 * notesSummary or the Doc.
 */
export function SessionNoteEditor({
  session,
  dateLabel,
  onDone,
}: {
  session: ReadingSession;
  dateLabel: string;
  onDone: () => void;
}) {
  const { updateSessionNote } = usePragyaActions();
  const [draft, setDraft] = useState(session.note || '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateSessionNote(session.id, draft);
      showToast('Session note saved.', 'success');
      onDone();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to save session note'), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2 w-full">
      <input
        ref={inputRef}
        type="text"
        enterKeyHint="done"
        data-testid={`session-note-input-${session.id}`}
        aria-label={`Session note for ${dateLabel}`}
        placeholder="What stood out? (optional)"
        maxLength={SESSION_NOTE_MAX}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        className={`${INPUT} h-11 sm:h-9 flex-1 min-w-[180px]`}
      />
      <button
        type="button"
        data-testid={`session-note-save-btn-${session.id}`}
        disabled={saving}
        onClick={() => void save()}
        className={BTN_SECONDARY}
      >
        Save
      </button>
      <button type="button" onClick={onDone} className={BTN_TERTIARY}>
        Cancel
      </button>
    </span>
  );
}

/** CD C2.3: `<details sessions-trail>` — last 10 sessions, newest first; hidden with 0 sessions. */
export function SessionsTrail({ book }: { book: Book }) {
  const { sessions } = usePragyaData();
  const [editingId, setEditingId] = useState<string | null>(null);
  const all = bookSessionsNewestFirst(sessions, book.id);
  if (all.length === 0) return null;
  const today = getLocalDateString();
  const shown = all.slice(0, SESSIONS_TRAIL_LIMIT);
  return (
    <details
      data-testid="sessions-trail"
      data-print-expand="true"
      className="group bg-card border border-border rounded-[14px] p-4"
    >
      <summary className="min-h-11 sm:min-h-0 flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={EYEBROW}>Recent Reading Sessions ({all.length})</span>
        <ChevronRight
          className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90 print:hidden"
          aria-hidden="true"
        />
      </summary>
      <ol data-testid="sessions-trail-list" className="mt-2 divide-y divide-border/60">
        {shown.map(s => {
          const dateLabel = sessionDateLabel(s.date, today);
          const delta = Math.max(0, (Number(s.endPos) || 0) - (Number(s.startPos) || 0));
          return (
            <li
              key={s.id}
              data-testid={`session-row-${s.id}`}
              className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label"
            >
              <span className="num text-foreground font-medium">{dateLabel}</span>
              <span className="num text-muted-foreground">
                {formatPosDisplay(Number(s.startPos) || 0, book.posUnit)} →{' '}
                {formatPosDisplay(Number(s.endPos) || 0, book.posUnit)}{' '}
                <span className="text-faint">(+{Math.round(delta * 100) / 100})</span>
              </span>
              {editingId === s.id ? (
                <SessionNoteEditor session={s} dateLabel={dateLabel} onDone={() => setEditingId(null)} />
              ) : s.note ? (
                <>
                  <span className="text-body text-foreground">{s.note}</span>
                  <button
                    type="button"
                    data-testid={`session-note-edit-btn-${s.id}`}
                    aria-label={`Edit note for ${dateLabel} session`}
                    onClick={() => setEditingId(s.id)}
                    className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid={`session-note-add-btn-${s.id}`}
                  onClick={() => setEditingId(s.id)}
                  className={BTN_TERTIARY}
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add note</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {all.length > SESSIONS_TRAIL_LIMIT && (
        <p className={`${HELPER} pt-2`}>Showing your 10 most recent sessions.</p>
      )}
    </details>
  );
}
