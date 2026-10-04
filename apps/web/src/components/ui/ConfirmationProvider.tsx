import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmationContext } from '../../lib/confirmation';
import { Button } from './Button';
import { ConfirmCancel, ConfirmDialog } from './ConfirmDialog';

type Request = { description: string; resolve: (confirmed: boolean) => void };

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const confirm = useCallback(
    (description: string) =>
      new Promise<boolean>((resolve) => {
        setRequests((previous) => [...previous, { description, resolve }]);
      }),
    [],
  );
  const request = requests[0];
  const finish = (confirmed: boolean) => {
    request?.resolve(confirmed);
    setRequests((previous) => previous.slice(1));
  };
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {request && (
        <ConfirmDialog
          title="Confirm action"
          description={request.description}
          open
          onOpenChange={(open) => {
            if (!open) finish(false);
          }}
        >
          <div className="modal-actions">
            <ConfirmCancel />
            <Button variant="primary" onClick={() => finish(true)}>
              Confirm
            </Button>
          </div>
        </ConfirmDialog>
      )}
    </ConfirmationContext.Provider>
  );
}
