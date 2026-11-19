import { useCallback, useState } from 'react';
import type { PromptFallbackModalProps } from '../components/common/PromptFallbackModal';
import { tryCopyText } from '../utils/capstonePrompt';
import { showToast } from '../utils/toast';

export interface UseCopyPromptOptions {
  successMessage: string;
  fallbackTitle?: string;
  fallbackTestId?: string;
  fallbackPromptLabel?: string;
}

export interface UseCopyPromptResult {
  copyPrompt: (prompt: string | null | undefined) => Promise<boolean>;
  fallbackModalProps: PromptFallbackModalProps;
}

/**
 * CD Batch 5 (decisions.md R2#1): consolidates clipboard write + toast + select-and-copy
 * fallback modal state across BookDetailView, CapstoneModal, NoteDetailView, and PracticeView.
 */
export function useCopyPrompt({
  successMessage,
  fallbackTitle = 'Copy Capstone Prompt',
  fallbackTestId = 'capstone-prompt-fallback-modal',
  fallbackPromptLabel = 'Capstone prompt',
}: UseCopyPromptOptions): UseCopyPromptResult {
  const [fallbackPrompt, setFallbackPrompt] = useState<string | null>(null);

  const copyPrompt = useCallback(
    async (prompt: string | null | undefined): Promise<boolean> => {
      if (!prompt) return false;
      if (await tryCopyText(prompt)) {
        showToast(successMessage, 'success');
        return true;
      }
      setFallbackPrompt(prompt);
      return false;
    },
    [successMessage]
  );

  const closeFallback = useCallback(() => {
    setFallbackPrompt(null);
  }, []);

  return {
    copyPrompt,
    fallbackModalProps: {
      isOpen: fallbackPrompt !== null,
      onClose: closeFallback,
      prompt: fallbackPrompt || '',
      title: fallbackTitle,
      dataTestId: fallbackTestId,
      promptLabel: fallbackPromptLabel,
    },
  };
}
