/** Verify Lab cookie constants — shared by the lab routes. Kept out of the
 *  route files because Next.js route modules may only export handlers. */
export const LAB_COOKIE = "biocheck_vl_key";
export const LAB_COOKIE_PATH = "/api/console/verify-lab";
export const LAB_COOKIE_MAX_AGE_S = 2 * 60 * 60;
