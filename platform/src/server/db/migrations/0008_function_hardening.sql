-- 0008: pin search_path on immutability-guard trigger functions.
-- Supabase security advisor flagged both as "function_search_path_mutable":
-- a role-controlled search_path could, in principle, shadow objects these
-- SECURITY-relevant triggers touch. Pinning to an empty search_path removes
-- the vector; the functions only RAISE, so they need no schema resolution.
ALTER FUNCTION forbid_audit_mutation() SET search_path = '';
ALTER FUNCTION forbid_policy_mutation() SET search_path = '';
