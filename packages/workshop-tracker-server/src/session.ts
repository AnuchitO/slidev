export interface WorkshopSession {
  id: string
  currentSlideIndex: number
  createdAt: number
}

// Singleton in-memory session (multi-session is out of scope — PRD §14/§4).
export const session: WorkshopSession = {
  id: 'default',
  currentSlideIndex: 1,
  createdAt: Date.now(),
}
