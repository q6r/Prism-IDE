export interface TreeDeletionApi {
  trashLocal: (path: string) => Promise<boolean>
  deleteRemote: (remoteId: string, path: string) => Promise<boolean>
}

/** Called only after the user confirms. A failed trash operation never falls back to rm. */
export async function deleteConfirmedTreeEntry(path: string, remoteId: string | null, api: TreeDeletionApi): Promise<void> {
  const deleted = remoteId === null ? await api.trashLocal(path) : await api.deleteRemote(remoteId, path)
  if (!deleted) throw new Error('Não foi possível excluir o item.')
}
