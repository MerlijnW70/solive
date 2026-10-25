import { PRODUCT_SLUG } from "@intent-engine/core/internal";

export const tool = (name: string): string => `${PRODUCT_SLUG}_${name}`;
