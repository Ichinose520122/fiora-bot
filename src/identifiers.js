// IDs remain strings: QQ numbers and Fiora MongoDB IDs use the same storage paths.
export function isPlatformId(value) {
  return /^[a-z0-9]{1,128}$/i.test(String(value ?? ''));
}

export function isChatKey(value) {
  return /^(group|private):[a-z0-9]{1,128}$/i.test(String(value ?? ''));
}
