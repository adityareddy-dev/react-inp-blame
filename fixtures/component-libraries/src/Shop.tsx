import { useState } from 'react'
import emotionStyled from '@emotion/styled'
import { Trash2, User } from 'lucide-react'
import { burn } from './burn'

const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// A product card inside a link: a click on its photo is a click on the card, not on the list around the link.
function ProductCard({ name }: { name: string }) {
  return (
    <div>
      <img src={PHOTO} width={96} height={64} alt="" data-testid="photo" />
      <span>{name}</span>
    </div>
  )
}

function ProductList() {
  return (
    <a
      href="#kettle"
      aria-label="Kettle"
      data-testid="product"
      onClick={(e) => {
        e.preventDefault()
        burn(120)
      }}
    >
      <ProductCard name="Kettle" />
    </a>
  )
}

// An option with an icon beside the name, as Headless UI's and Radix's listboxes draw them.
function PersonOption({ name }: { name: string }) {
  return (
    <>
      <User size={24} />
      <span>{name}</span>
    </>
  )
}

function PeoplePicker() {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <ul role="listbox" aria-label="People">
      <li
        role="option"
        aria-selected={picked === 'Ada'}
        data-testid="person"
        onClick={() => {
          burn(120)
          setPicked('Ada')
        }}
      >
        <PersonOption name="Ada" />
      </li>
    </ul>
  )
}

// A gallery whose thumbnails handle their own clicks: an image with a handler is what was clicked.
function Thumbnail({ i }: { i: number }) {
  return <img src={PHOTO} width={48} height={48} alt="" data-testid={`thumb-${i}`} onClick={() => burn(120)} />
}

function Gallery() {
  return (
    <div>
      {[0, 1, 2].map((i) => (
        <Thumbnail key={i} i={i} />
      ))}
    </div>
  )
}

// An icon given the handler itself: lucide passes onClick through to its <svg>.
function RemoveTag() {
  return (
    <span>
      Remove <Trash2 size={24} data-testid="trash-inline" onClick={() => burn(120)} />
    </span>
  )
}

// MUI labels each root it styles with @emotion/styled, so its wrapper has a name that reads like the app's.
const ShopButtonRoot = emotionStyled('button', { label: 'ShopButtonRoot' })`
  padding: 4px 8px;
`

function BuyButton() {
  return (
    <ShopButtonRoot type="button" data-testid="buy" onClick={() => burn(120)}>
      Buy
    </ShopButtonRoot>
  )
}

export function Shop() {
  return (
    <section>
      <ProductList />
      <PeoplePicker />
      <Gallery />
      <RemoveTag />
      <BuyButton />
    </section>
  )
}
