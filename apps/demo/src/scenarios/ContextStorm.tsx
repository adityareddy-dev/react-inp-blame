import { createContext, memo, useContext, useState } from 'react';
import { burn } from '../burn';

const CartContext = createContext<{ items: number; add: () => void }>({ items: 0, add: () => {} });

/** Anti-pattern: a fresh context value object every render. Every consumer re-renders, memo or not. */
export function ContextStorm() {
  const [items, setItems] = useState(0);
  const value = { items, add: () => setItems((n) => n + 1) };
  return (
    <CartContext.Provider value={value}>
      <button className="primary" data-test="trigger" onClick={value.add}>
        Add to cart ({items})
      </button>
      <OrderSummary />
    </CartContext.Provider>
  );
}

const OrderSummary = memo(function OrderSummary() {
  return (
    <ul className="grid">
      {Array.from({ length: 800 }, (_, i) => (
        <LineItem key={i} index={i} />
      ))}
    </ul>
  );
});

const LineItem = memo(function LineItem({ index }: { index: number }) {
  const { items } = useContext(CartContext);
  burn(0.12);
  return (
    <li>
      <b>Item {index}</b> · qty {items}
    </li>
  );
});
