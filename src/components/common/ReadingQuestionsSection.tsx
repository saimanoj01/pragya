import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, HelpCircle, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { Book, Note, ReadingQuestion } from '../../types/pragya';
import { usePragyaActions } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import { isArchived } from '../../utils/archive';
import {
  BOOK_QUESTIONS_OWNED_META_KEYS,
  MAX_OPEN_READING_QUESTIONS,
  READING_ANSWER_MAX,
  READING_QUESTION_MAX,
  getBookReadingQuestions,
} from '../../utils/metaCodecs';
import { navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import {
  addReadingQuestion,
  answerReadingQuestion,
  removeReadingQuestion,
  reopenReadingQuestion,
} from '../../utils/readingMomentum';
import { formatPosDisplay, isNoteSpoiler, isSealedPrediction } from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_TERTIARY, EYEBROW, INPUT, SELECT } from './uiClasses';

export interface ReadingQuestionsSectionProps {
  book: Book;
  bookNotes: readonly Note[];
}

/**
 * v2: Reading Questions curiosity anchors stored in Books.metaJson.readingQuestions.
 * Available on any book (non-fiction framing by default; collapsed when empty or on fiction
 * so Captured Notes stays prominent on mobile). Re-checks spoiler/archive status on noteId
 * links at render time.
 */
export const ReadingQuestionsSection: React.FC<ReadingQuestionsSectionProps> = ({
  book,
  bookNotes,
}) => {
  const { updateBook } = usePragyaActions();
  const questions = useMemo(() => getBookReadingQuestions(book.meta), [book.meta]);
  const openCount = useMemo(
    () => questions.filter(q => q.status === 'open').length,
    [questions]
  );

  const safeLinkableNotes = useMemo(
    () =>
      bookNotes.filter(
        n =>
          n.bookId === book.id &&
          !isArchived(n) &&
          !isNoteSpoiler(n, book) &&
          !isSealedPrediction(n, book)
      ),
    [book, bookNotes]
  );

  const safeNoteById = useMemo(
    () => new Map(safeLinkableNotes.map(n => [n.id, n] as const)),
    [safeLinkableNotes]
  );

  const [isOpen, setIsOpen] = useState(
    () => book.kind === 'nonfiction' && questions.length > 0
  );
  const [newQuestion, setNewQuestion] = useState('');
  const [adding, setAdding] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');
  const [noteIdDraft, setNoteIdDraft] = useState('');
  const [noteIdTouched, setNoteIdTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const answerInputRef = useRef<HTMLInputElement | null>(null);
  const answerTriggerRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  useEffect(() => {
    setIsOpen(book.kind === 'nonfiction' && getBookReadingQuestions(book.meta).length > 0);
    setAdding(false);
    setNewQuestion('');
    setAnsweringId(null);
    setAnswerDraft('');
    setNoteIdDraft('');
    setNoteIdTouched(false);
    // Reset cleanly when switching books even if parent doesn't re-key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (answeringId) answerInputRef.current?.focus();
  }, [answeringId]);

  const archived = isArchived(book);

  if (archived && questions.length === 0) return null;

  const persistQuestions = async (nextRaw: unknown[] | undefined, successMsg: string) => {
    setBusy(true);
    try {
      const nextMeta = { ...book.meta };
      if (nextRaw && nextRaw.length > 0) nextMeta.readingQuestions = nextRaw;
      else delete nextMeta.readingQuestions;
      await updateBook(
        { ...book, meta: nextMeta },
        {
          expectedBaseUpdatedAt: book.meta?.updatedAt,
          ownedMetaKeys: BOOK_QUESTIONS_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      showToast(successMsg, 'success');
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update reading questions'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const closeAddForm = (restoreFocus = false) => {
    setAdding(false);
    setNewQuestion('');
    if (restoreFocus) {
      requestAnimationFrame(() => addBtnRef.current?.focus());
    }
  };

  const closeAnswerForm = (qId: string, restoreFocus = false) => {
    setAnsweringId(null);
    setAnswerDraft('');
    setNoteIdDraft('');
    setNoteIdTouched(false);
    if (restoreFocus) {
      requestAnimationFrame(() => answerTriggerRefs.current.get(qId)?.focus());
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestion.trim() || busy) return;
    try {
      const nextRaw = addReadingQuestion(book.meta?.readingQuestions, newQuestion);
      await persistQuestions(nextRaw, 'Reading question added.');
      closeAddForm(true);
    } catch (err) {
      showToast(describeSyncError(err, 'Could not add question'), 'error');
    }
  };

  const startAnswer = (q: ReadingQuestion) => {
    setAnsweringId(q.id);
    setAnswerDraft(q.answer || '');
    setNoteIdDraft(q.noteId && safeNoteById.has(q.noteId) ? q.noteId : '');
    setNoteIdTouched(false);
  };

  const handleSaveAnswer = async (e: React.FormEvent, qId: string) => {
    e.preventDefault();
    if (busy) return;
    try {
      const nextRaw = answerReadingQuestion(book.meta?.readingQuestions, qId, {
        answer: answerDraft,
        ...(noteIdTouched ? { noteId: noteIdDraft } : {}),
      });
      await persistQuestions(nextRaw, 'Question marked answered.');
      closeAnswerForm(qId, true);
    } catch (err) {
      showToast(describeSyncError(err, 'Could not save answer'), 'error');
    }
  };

  const handleReopen = async (qId: string) => {
    if (busy) return;
    try {
      const nextRaw = reopenReadingQuestion(book.meta?.readingQuestions, qId);
      await persistQuestions(nextRaw, 'Question reopened.');
    } catch (err) {
      showToast(describeSyncError(err, 'Could not reopen question'), 'error');
    }
  };

  const handleRemove = async (qId: string) => {
    if (busy) return;
    try {
      const nextRaw = removeReadingQuestion(book.meta?.readingQuestions, qId);
      await persistQuestions(nextRaw, 'Question removed.');
    } catch (err) {
      showToast(describeSyncError(err, 'Could not remove question'), 'error');
    }
  };

  const headingLabel =
    book.kind === 'fiction'
      ? `Reading Questions (${questions.length})`
      : `Questions I'm Reading to Answer (${questions.length})`;

  return (
    <details
      data-testid="reading-questions-section"
      data-print-expand="true"
      open={isOpen}
      onToggle={e => setIsOpen(e.currentTarget.open)}
      className={`group bg-card border border-border rounded-[14px] p-4 ${
        questions.length === 0 ? 'print:hidden' : ''
      }`}
    >
      <summary className="min-h-11 sm:min-h-0 flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={`inline-flex items-center gap-1.5 ${EYEBROW} num`}>
          <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{headingLabel}</span>
        </span>
        <ChevronRight
          className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90 print:hidden shrink-0"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-3 space-y-3">
        {questions.length === 0 ? (
          <p className="text-label text-muted-foreground">
            Jot a question you hope this book helps you think through (up to{' '}
            {MAX_OPEN_READING_QUESTIONS} open).
          </p>
        ) : (
          <ul className="space-y-2.5">
            {questions.map(q => {
              const linkedNote = q.noteId ? safeNoteById.get(q.noteId) : undefined;
              const isEditingThis = answeringId === q.id;
              return (
                <li
                  key={q.id}
                  data-testid={`reading-question-${q.id}`}
                  className="rounded-[10px] bg-surface2/50 border border-border p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <p
                        className={`text-body break-words ${
                          q.status === 'answered'
                            ? 'text-muted-foreground'
                            : 'text-foreground font-medium'
                        }`}
                      >
                        {q.question}
                      </p>
                      {q.status === 'answered' && q.answer && (
                        <p className="text-label text-foreground break-words">{q.answer}</p>
                      )}
                      {linkedNote && (
                        <button
                          type="button"
                          data-print-keep="true"
                          onClick={() => navigateTo(noteHref(linkedNote, book))}
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 max-w-full inline-flex items-center text-left text-label font-mono text-muted-foreground hover:text-foreground hover:underline break-all"
                        >
                          Linked: [[{linkedNote.meta?.title || linkedNote.slug}]]
                        </button>
                      )}
                    </div>

                    {!archived && (
                      <div className="print:hidden flex items-center gap-1 shrink-0">
                        {q.status === 'open' ? (
                          <button
                            ref={el => {
                              answerTriggerRefs.current.set(q.id, el);
                            }}
                            type="button"
                            data-testid={`reading-question-answer-btn-${q.id}`}
                            disabled={busy}
                            onClick={() => startAnswer(q)}
                            className={BTN_TERTIARY}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-positive" aria-hidden="true" />
                            <span>Answer</span>
                          </button>
                        ) : (
                          <>
                            <button
                              ref={el => {
                                answerTriggerRefs.current.set(q.id, el);
                              }}
                              type="button"
                              disabled={busy}
                              onClick={() => startAnswer(q)}
                              className={BTN_TERTIARY}
                            >
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleReopen(q.id)}
                              aria-label="Reopen question"
                              title="Reopen question"
                              className={BTN_TERTIARY}
                            >
                              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          data-testid={`reading-question-remove-btn-${q.id}`}
                          disabled={busy}
                          onClick={() => void handleRemove(q.id)}
                          aria-label="Remove question"
                          title="Remove question"
                          className={BTN_TERTIARY}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditingThis && (
                    <form
                      onSubmit={e => void handleSaveAnswer(e, q.id)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          closeAnswerForm(q.id, true);
                        }
                      }}
                      className="print:hidden pt-2 border-t border-border/60 space-y-2"
                    >
                      <input
                        ref={answerInputRef}
                        type="text"
                        enterKeyHint="done"
                        maxLength={READING_ANSWER_MAX}
                        data-testid={`reading-question-answer-input-${q.id}`}
                        aria-label="Short answer"
                        value={answerDraft}
                        onChange={e => setAnswerDraft(e.target.value)}
                        placeholder="Short answer in your own words (optional)"
                        className={INPUT}
                      />
                      {safeLinkableNotes.length > 0 && (
                        <select
                          aria-label="Link to a note from this book"
                          data-testid={`reading-question-note-select-${q.id}`}
                          value={noteIdDraft}
                          onChange={e => {
                            setNoteIdDraft(e.target.value);
                            setNoteIdTouched(true);
                          }}
                          className={SELECT}
                        >
                          <option value="">No linked note</option>
                          {safeLinkableNotes.map(n => (
                            <option key={n.id} value={n.id}>
                              {formatPosDisplay(Number(n.pos) || 0, book.posUnit)} ·{' '}
                              {n.meta?.title || n.takeaway.slice(0, 48) || n.slug}
                            </option>
                          ))}
                        </select>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => closeAnswerForm(q.id, true)}
                          className={BTN_TERTIARY}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          data-testid={`reading-question-answer-save-${q.id}`}
                          disabled={busy}
                          className={BTN_PRIMARY}
                        >
                          Save Answer
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!archived &&
          (adding ? (
            <form
              onSubmit={e => void handleAdd(e)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeAddForm(true);
                }
              }}
              className="print:hidden space-y-2"
            >
              <input
                ref={addInputRef}
                type="text"
                enterKeyHint="done"
                maxLength={READING_QUESTION_MAX}
                data-testid="reading-question-add-input"
                aria-label="New reading question"
                value={newQuestion}
                onChange={e => setNewQuestion(e.target.value)}
                placeholder="What are you hoping to understand?"
                className={INPUT}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => closeAddForm(true)}
                  className={BTN_TERTIARY}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="reading-question-add-submit"
                  disabled={busy || !newQuestion.trim()}
                  className={BTN_SECONDARY}
                >
                  Add Question
                </button>
              </div>
            </form>
          ) : openCount < MAX_OPEN_READING_QUESTIONS ? (
            <button
              ref={addBtnRef}
              type="button"
              data-testid="reading-question-add-btn"
              onClick={() => setAdding(true)}
              className={`print:hidden ${BTN_TERTIARY}`}
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add reading question</span>
            </button>
          ) : (
            <p className="print:hidden text-label text-muted-foreground">
              {MAX_OPEN_READING_QUESTIONS} open questions reached — answer or remove one to add
              more.
            </p>
          ))}
      </div>
    </details>
  );
};
