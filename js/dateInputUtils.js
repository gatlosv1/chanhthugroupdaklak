export function shouldSyncDateInputValue({ currentValue, fallbackValue, manuallySelected, isInitialLoad = false }) {
  if (manuallySelected) {
    return false;
  }

  if (isInitialLoad) {
    return !currentValue;
  }

  return !currentValue && Boolean(fallbackValue);
}
