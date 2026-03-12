import { useState } from 'react';
import { useDebateActions } from '../context/DebateContext';
import ReplacementModelPickerModal from './ReplacementModelPickerModal';

export default function ReplaceModelButton({
  className,
  currentModel,
  roundModels = [],
  roundIndex,
  streamIndex,
  roundNumber,
  totalRounds = 1,
  turnMode = 'debate',
  title = 'Choose a backup model. Shift starts with cache bypass enabled.',
  children,
}) {
  const { replaceStreamModel } = useDebateActions();
  const [open, setOpen] = useState(false);
  const [initialForceRefresh, setInitialForceRefresh] = useState(false);

  if (!currentModel) return null;

  return (
    <>
      <button
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          setInitialForceRefresh(Boolean(event.shiftKey));
          setOpen(true);
        }}
        title={title}
        type="button"
      >
        {children}
      </button>
      <ReplacementModelPickerModal
        open={open}
        onClose={() => setOpen(false)}
        currentModel={currentModel}
        roundModels={roundModels}
        roundNumber={roundNumber}
        totalRounds={totalRounds}
        turnMode={turnMode}
        initialForceRefresh={initialForceRefresh}
        onSelect={(replacementModel, options = {}) => {
          replaceStreamModel(roundIndex, streamIndex, {
            ...options,
            replacementModel,
          });
          setOpen(false);
        }}
      />
    </>
  );
}
