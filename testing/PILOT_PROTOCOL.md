# BioCheck Verify controlled pilot protocol

## Boundary

This is a consent-led, non-production evaluation of BioCheck's 1:1 verification
and PAD workflow. It is not a surveillance exercise and it must not make an
automated decision about a person's access to healthcare, work, credit, travel,
insurance or public service.

## Minimum participant set

- **30 adult volunteers**, recruited with a signed, plain-language consent form.
- Record only a pseudonymous participant code in the results CSV. Keep signed
  consents separately with the test lead.
- Each volunteer completes two sessions on different days/devices where possible:
  one reference capture and five genuine verification attempts in varied light,
  pose and glasses/mask conditions.
- Form 870 controlled impostor comparisons (each participant against 30 non-self
  templates) and at least 150 supervised presentation attacks: printed photo,
  phone-screen photo, phone-screen video, video replay and, where safe/legal,
  synthetic-video replay.
- Do not collect children or use captured data for model training.

## Consent wording (short form)

> I voluntarily agree to take part in the BioCheck Verify pilot. BioCheck will
> use my facial images only to test 1:1 identity verification and liveness in
> this pilot. My images will not be used to train a model, sold, or used for
> surveillance. I may withdraw before the test report is finalised, and my pilot
> images and template will then be deleted unless a legal retention duty applies.

The test lead must add purpose, retention date, withdrawal contact, controller,
security measures and any country-specific privacy wording before use.

## Pass/fail and reporting

Before testing, approve the target operating point. Initial gates for a pilot:

- zero successful presentation attacks in the defined attack set;
- false-accept rate at or below 0.1% in the controlled impostor set;
- genuine acceptance at or above 95% for captures that meet the quality rule;
- no unexplained material performance gap across recorded capture conditions.

These are pilot gates, **not certification claims**. Report confidence intervals,
sample size, exclusions, failures and every model/policy version.

## Results file

Create `testing/results.csv` (never commit images) with:

`participant_code,attempt_id,attempt_type,expected_live,expected_match,quality,similarity,liveness_score,decision,model_sha256,pilot_operator,timestamp`

Attempt types: `genuine`, `impostor`, `print_attack`, `screen_photo`,
`screen_video`, `synthetic_video`. The independent test lead signs the final
report and a deletion confirmation.
