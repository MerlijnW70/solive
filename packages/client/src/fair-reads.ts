import type { ReadonlyUint8Array } from "@solana/kit";
import { type ClaimBoard, decodeClaimBoardOrOlder, decodeDeliveryBookOrOlder, type DeliveryBook, getDeliveryBookSize, isOlderBoard, isOlderBook, V1_BOOK_SPACE } from "@intent-engine/core/internal";

export const isOldBoard = (data: ReadonlyUint8Array): boolean => isOlderBoard(data);

export const isOldBook = (data: ReadonlyUint8Array): boolean => isOlderBook(data);

export const readBoard = (data: ReadonlyUint8Array): ClaimBoard => decodeClaimBoardOrOlder(data);

export const readBook = (data: ReadonlyUint8Array): DeliveryBook => decodeDeliveryBookOrOlder(data);

export const BOOK_SIZES: readonly number[] = [getDeliveryBookSize(), V1_BOOK_SPACE];