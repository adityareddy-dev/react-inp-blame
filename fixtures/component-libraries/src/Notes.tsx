/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { burn } from './burn'

// @emotion/react's css prop wraps each element in a component of its own, with an Insertion beside it.
function NoteRow({ i, round }: { i: number; round: number }) {
  burn(0.25)
  return (
    <li css={{ fontWeight: 600 }}>
      Note {i}: {round}
    </li>
  )
}

function NoteList({ round }: { round: number }) {
  return (
    <ul css={{ columns: 4 }}>
      {Array.from({ length: 400 }, (_, i) => (
        <NoteRow key={i} i={i} round={round} />
      ))}
    </ul>
  )
}

export function Notes() {
  const [round, setRound] = useState(0)
  return (
    <section>
      <button type="button" data-testid="renote" onClick={() => setRound((r) => r + 1)}>
        Renote {round}
      </button>
      <NoteList round={round} />
    </section>
  )
}
