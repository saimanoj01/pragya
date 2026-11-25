import React, { useId } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Modal } from '../common/Modal';

export interface SessionExpiredModalProps {
  isOpen: boolean;
  onReconnect: () => void;
  onSwitchAccount?: () => void;
  onContinueDemo: () => void;
  onClose: () => void;
}

export const SessionExpiredModal: React.FC<SessionExpiredModalProps> = ({
  isOpen,
  onReconnect,
  onSwitchAccount,
  onContinueDemo,
  onClose,
}) => {
  const headingId = useId();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="session-expired-modal"
      title="Google Session Expired"
      headingId={headingId}
      maxWidth="max-w-sm"
    >
      <div className="space-y-4 text-center">
        <div className="w-11 h-11 rounded-full bg-negative/10 border border-negative/30 text-negative flex items-center justify-center mx-auto">
          <ShieldAlert className="w-5 h-5" />
        </div>
        <div>
          <h3 id={headingId} className="text-heading text-foreground">
            Session Expired
          </h3>
          <p className="text-body text-muted-foreground mt-1">
            Your Google OAuth token expired or was revoked. Reconnect to sync your sheet, or switch
            to offline Demo Mode.
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            data-testid="session-reauth-btn"
            onClick={onReconnect}
            className="w-full h-11 sm:h-10 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 transition-opacity"
          >
            Reconnect Google
          </button>
          <button
            type="button"
            data-testid="session-demo-btn"
            onClick={onContinueDemo}
            className="w-full h-11 sm:h-10 rounded-[10px] bg-surface2 border border-border text-foreground font-medium text-body hover:bg-secondary transition-colors"
          >
            Continue in Demo Mode
          </button>
          {onSwitchAccount && (
            <button
              type="button"
              data-testid="session-switch-account-btn"
              onClick={onSwitchAccount}
              className="w-full min-h-11 sm:min-h-8 text-label text-muted-foreground hover:text-foreground transition-colors"
            >
              Switch Google account
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};
