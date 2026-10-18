/** Preserve a file's suffix when space is tight, as Pierre's middle truncation does. */
export function FileTreeName({ name, isDir }: { name: string; isDir: boolean }) {
  const dot = name.lastIndexOf('.')
  if (isDir || dot <= 0) return <span className="pr-files-name">{name}</span>
  return <span className="pr-files-name pr-files-middle-name">
    <span className="pr-files-name-stem">{name.slice(0, dot)}</span>
    <span className="pr-files-name-suffix">{name.slice(dot)}</span>
  </span>
}
