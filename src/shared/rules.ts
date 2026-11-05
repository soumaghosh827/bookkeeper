// Business rules shared by main and renderer. Change numbers here, nowhere else.
export const DELETE_WINDOW_HOURS = 48 // a transaction can be deleted only within this time of creation
export const HIGH_VALUE_PAISE = 1_000_000_000 // Rs 1 Cr: asks the user to retype the amount
export const MAX_CUSTOM_COLUMNS = 20

export const canDelete = (createdAt: string, now = Date.now()) =>
  now - Date.parse(createdAt) <= DELETE_WINDOW_HOURS * 3_600_000
