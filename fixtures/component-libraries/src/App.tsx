import { useState } from 'react'
import styled from 'styled-components'
import emotionStyled from '@emotion/styled'
import { Check, Minus, Trash2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

/** Keeps the main thread busy for `ms`, so each part of the page has a slow interaction to report. */
function burn(ms: number) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // busy
  }
}

// styled-components names these `styled.ul` and `styled.li`, in development and production builds.
const PriceTable = styled.ul`
  columns: 4;
`
const Price = styled.li`
  font-variant-numeric: tabular-nums;
`

function PriceRow({ i, round }: { i: number; round: number }) {
  burn(0.25)
  return (
    <Price>
      Price {i}: {round}
    </Price>
  )
}

function PriceList({ round }: { round: number }) {
  return (
    <PriceTable>
      {Array.from({ length: 400 }, (_, i) => (
        <PriceRow key={i} i={i} round={round} />
      ))}
    </PriceTable>
  )
}

function Prices() {
  const [round, setRound] = useState(0)
  return (
    <section>
      <button type="button" data-testid="reprice" onClick={() => setRound((r) => r + 1)}>
        Reprice {round}
      </button>
      <PriceList round={round} />
    </section>
  )
}

// @emotion/styled names these `Styled(ul)` and `Styled(li)`, and renders an `Insertion` beside each.
const TagCloud = emotionStyled.ul`
  columns: 4;
`
const Tag = emotionStyled.li`
  font-style: italic;
`

function TagRow({ i, round }: { i: number; round: number }) {
  burn(0.25)
  return (
    <Tag>
      Tag {i}: {round}
    </Tag>
  )
}

function TagList({ round }: { round: number }) {
  return (
    <TagCloud>
      {Array.from({ length: 400 }, (_, i) => (
        <TagRow key={i} i={i} round={round} />
      ))}
    </TagCloud>
  )
}

function Tags() {
  const [round, setRound] = useState(0)
  return (
    <section>
      <button type="button" data-testid="retag" onClick={() => setRound((r) => r + 1)}>
        Retag {round}
      </button>
      <TagList round={round} />
    </section>
  )
}

// lucide-react gives every icon a displayName, so an icon is a component of its own inside the button.
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  return (
    <button type="button" aria-label="Delete row" data-testid="delete" onClick={onDelete}>
      <Trash2 size={32} />
    </button>
  )
}

// The click swaps the icon, so the element it landed on has left the page before its entry arrives.
function SelectAll({ all, toggle }: { all: boolean; toggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={all} aria-label="Select all" data-testid="select-all" onClick={toggle}>
      {all ? <Check size={32} /> : <Minus size={32} />}
    </button>
  )
}

function Icons() {
  const [rows, setRows] = useState(3)
  const [all, setAll] = useState(false)
  return (
    <section>
      <p>Rows: {rows}</p>
      <DeleteButton
        onDelete={() => {
          burn(120)
          setRows((n) => n - 1)
        }}
      />
      <SelectAll
        all={all}
        toggle={() => {
          burn(120)
          setAll((a) => !a)
        }}
      />
    </section>
  )
}

function Action({ i }: { i: number }) {
  burn(0.25)
  return <DropdownMenu.Item>Action {i}</DropdownMenu.Item>
}

// Radix opens the menu on pointerdown. The row's own onClick, around the trigger, does nothing slow.
function RowActions() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger data-testid="row-actions" aria-label="Row actions">
        ⋯
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          {Array.from({ length: 400 }, (_, i) => (
            <Action key={i} i={i} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Row() {
  const [selected, setSelected] = useState(false)
  return (
    <div data-testid="row" aria-selected={selected} onClick={() => setSelected((s) => !s)}>
      Row <RowActions />
    </div>
  )
}

export default function App() {
  return (
    <main>
      <Icons />
      <Row />
      <Prices />
      <Tags />
    </main>
  )
}
