/**
 * Editable default department and cadre catalogue.
 *
 * This is a starting catalogue, not a claim that every country-specific cadre,
 * title or legal requirement is covered. Facilities enable only the departments
 * they actually operate and may rename local titles. ISCO-08 mappings are
 * intentionally absent until reviewed; the schema stores them separately.
 */
export interface CatalogueDepartment {
  code: string;
  name: string;
  type:
    | "governance"
    | "patient-access"
    | "outpatient"
    | "emergency"
    | "inpatient"
    | "maternity"
    | "pediatrics"
    | "critical-care"
    | "theatre"
    | "laboratory"
    | "blood-bank"
    | "radiology"
    | "pharmacy"
    | "renal"
    | "mental-health"
    | "rehabilitation"
    | "nutrition"
    | "dental"
    | "eye-ent"
    | "primary-community"
    | "palliative"
    | "ipc-quality"
    | "cssd"
    | "mortuary"
    | "housekeeping"
    | "portering"
    | "engineering"
    | "catering"
    | "security"
    | "finance"
    | "hr"
    | "procurement"
    | "digital-health"
    | "other";
  units: { code: string; name: string; type?: string }[];
  cadres: { code: string; name: string; category: string }[];
}

export const DEFAULT_DEPARTMENTS: CatalogueDepartment[] = [
  {
    code: "GOV", name: "Governance and executive administration", type: "governance",
    units: [
      { code: "GOV-EXEC", name: "Governing body and executive office" },
      { code: "GOV-MED", name: "Medical administration" },
      { code: "GOV-NUR", name: "Nursing and midwifery administration" },
      { code: "GOV-OPS", name: "Hospital operations" },
    ],
    cadres: [
      { code: "HOSP-ADMIN", name: "Hospital administrator", category: "administration" },
      { code: "MED-DIR", name: "Medical director or superintendent", category: "medical" },
      { code: "NUR-DIR", name: "Nursing director or matron", category: "nursing" },
      { code: "OPS-MGR", name: "Operations manager", category: "administration" },
      { code: "ADMIN-OFF", name: "Administrative officer", category: "administration" },
      { code: "EXEC-ASST", name: "Executive assistant", category: "administration" },
    ],
  },
  {
    code: "ACCESS", name: "Patient access and health information", type: "patient-access",
    units: [
      { code: "ACCESS-REC", name: "Reception and registration" },
      { code: "ACCESS-APP", name: "Appointments and call centre" },
      { code: "ACCESS-RECORDS", name: "Health records" },
      { code: "ACCESS-REL", name: "Patient relations and complaints" },
    ],
    cadres: [
      { code: "RECEPTION", name: "Receptionist", category: "administrative" },
      { code: "REG-OFF", name: "Registration officer", category: "administrative" },
      { code: "APPT-OFF", name: "Appointment or call-centre officer", category: "administrative" },
      { code: "HRO", name: "Health records officer", category: "health-information" },
      { code: "HIM", name: "Health information manager", category: "health-information" },
      { code: "CODER", name: "Medical coder", category: "health-information" },
      { code: "REL-OFF", name: "Patient relations officer", category: "administrative" },
    ],
  },
  {
    code: "OPD", name: "Outpatient and specialist clinics", type: "outpatient",
    units: [
      { code: "OPD-GEN", name: "General outpatient" },
      { code: "OPD-MED", name: "Internal medicine" },
      { code: "OPD-SURG", name: "Surgical clinic" },
      { code: "OPD-SPEC", name: "Other configured specialty clinics" },
    ],
    cadres: [
      { code: "MED-OFF", name: "Medical officer", category: "medical" },
      { code: "CLIN-OFF", name: "Clinical officer or associate", category: "clinical" },
      { code: "SPEC-PHYS", name: "Specialist physician", category: "medical" },
      { code: "CONSULTANT", name: "Consultant", category: "medical" },
      { code: "NURSE", name: "Registered or enrolled nurse", category: "nursing" },
      { code: "HCA", name: "Healthcare assistant", category: "support" },
      { code: "CLIN-COORD", name: "Clinic coordinator", category: "administrative" },
    ],
  },
  {
    code: "EMERG", name: "Emergency and ambulance services", type: "emergency",
    units: [
      { code: "EMERG-TRIAGE", name: "Triage" },
      { code: "EMERG-TREAT", name: "Emergency treatment" },
      { code: "EMERG-RESUS", name: "Resuscitation" },
      { code: "EMERG-OBS", name: "Observation" },
      { code: "EMERG-AMB", name: "Ambulance and referral coordination" },
    ],
    cadres: [
      { code: "EMERG-PHYS", name: "Emergency physician or medical officer", category: "medical" },
      { code: "EMERG-NURSE", name: "Emergency nurse", category: "nursing" },
      { code: "PARAMEDIC", name: "Paramedic or emergency medical technician", category: "emergency" },
      { code: "AMB-DRIVER", name: "Ambulance driver", category: "support" },
      { code: "EMERG-ASST", name: "Emergency care assistant", category: "support" },
      { code: "REF-COORD", name: "Referral coordinator", category: "administrative" },
    ],
  },
  {
    code: "WARD", name: "Inpatient medical and surgical services", type: "inpatient",
    units: [
      { code: "WARD-GEN", name: "General ward" },
      { code: "WARD-AM", name: "Adult male ward" },
      { code: "WARD-AF", name: "Adult female ward" },
      { code: "WARD-MED", name: "Medical ward" },
      { code: "WARD-SURG", name: "Surgical ward" },
      { code: "WARD-ISO", name: "Isolation ward where supported" },
    ],
    cadres: [
      { code: "PHYS-WARD", name: "Physician or medical officer", category: "medical" },
      { code: "SURGEON", name: "Surgeon", category: "medical" },
      { code: "WARD-IC", name: "Ward in-charge", category: "nursing" },
      { code: "WARD-NURSE", name: "Ward nurse", category: "nursing" },
      { code: "WARD-HCA", name: "Healthcare assistant", category: "support" },
      { code: "WARD-CLERK", name: "Ward clerk", category: "administrative" },
    ],
  },
  {
    code: "MAT", name: "Maternal and reproductive health", type: "maternity",
    units: [
      { code: "MAT-ADMIN", name: "Maternity administration" },
      { code: "MAT-ANC", name: "Antenatal clinic" },
      { code: "MAT-TRIAGE", name: "Obstetric triage" },
      { code: "MAT-LD", name: "Labour and delivery" },
      { code: "MAT-PNC", name: "Postnatal ward" },
      { code: "MAT-HRP", name: "High-risk pregnancy clinic" },
      { code: "MAT-FP", name: "Family planning" },
      { code: "MAT-GYN", name: "Gynaecology" },
      { code: "MAT-OBS", name: "Obstetric emergency coordination" },
    ],
    cadres: [
      { code: "OBGYN", name: "Obstetrician or gynaecologist", category: "medical" },
      { code: "MAT-MO", name: "Medical officer", category: "medical" },
      { code: "MIDWIFE", name: "Midwife", category: "midwifery" },
      { code: "MAT-NURSE", name: "Maternity nurse", category: "nursing" },
      { code: "MAT-IC", name: "Maternity in-charge", category: "midwifery" },
      { code: "RH-COUNS", name: "Reproductive health counsellor", category: "counselling" },
      { code: "LACT-COACH", name: "Lactation support practitioner", category: "midwifery" },
      { code: "MAT-CLERK", name: "Maternity records or ward clerk", category: "administrative" },
    ],
  },
  {
    code: "PED", name: "Pediatrics and neonatal services", type: "pediatrics",
    units: [
      { code: "PED-CLINIC", name: "Pediatric clinic" },
      { code: "PED-WARD", name: "Pediatric ward" },
      { code: "PED-NEWBORN", name: "Newborn care" },
      { code: "PED-HDU", name: "Neonatal high-dependency care" },
      { code: "PED-NICU", name: "NICU" },
    ],
    cadres: [
      { code: "PEDIATRICIAN", name: "Pediatrician", category: "medical" },
      { code: "NEONATOLOGIST", name: "Neonatologist", category: "medical" },
      { code: "PED-MO", name: "Medical officer", category: "medical" },
      { code: "PED-NURSE", name: "Pediatric nurse", category: "nursing" },
      { code: "NEO-NURSE", name: "Neonatal nurse", category: "nursing" },
      { code: "PED-HCA", name: "Healthcare assistant", category: "support" },
      { code: "NEO-SUPPORT", name: "Authorized neonatal support practitioner", category: "nursing" },
    ],
  },
  {
    code: "CRIT", name: "Critical care", type: "critical-care",
    units: [
      { code: "CRIT-ICU", name: "ICU" },
      { code: "CRIT-HDU", name: "High-dependency unit" },
      { code: "CRIT-SPEC", name: "Specialty critical-care areas" },
    ],
    cadres: [
      { code: "INTENSIVIST", name: "Intensivist", category: "medical" },
      { code: "CRIT-MO", name: "Critical-care medical officer", category: "medical" },
      { code: "CRIT-NURSE", name: "Critical-care nurse", category: "nursing" },
      { code: "RESP-THERAPIST", name: "Respiratory therapist", category: "allied-health" },
      { code: "CRIT-PHARM", name: "Clinical pharmacist assigned to critical care", category: "pharmacy" },
      { code: "CRIT-COORD", name: "Critical-care coordinator", category: "administration" },
    ],
  },
  {
    code: "THEATRE", name: "Surgery, theatre, anesthesia and recovery", type: "theatre",
    units: [
      { code: "THEATRE-PREOP", name: "Preoperative assessment" },
      { code: "THEATRE-OT", name: "Operating theatres" },
      { code: "THEATRE-ANES", name: "Anesthesia" },
      { code: "THEATRE-PACU", name: "Post-anesthesia recovery" },
      { code: "THEATRE-DAY", name: "Day surgery" },
    ],
    cadres: [
      { code: "THEATRE-SURG", name: "Surgeon", category: "medical" },
      { code: "ANESTH", name: "Anesthesiologist", category: "medical" },
      { code: "ANES-PROV", name: "Authorized anesthesia provider", category: "anesthesia" },
      { code: "THEATRE-NURSE", name: "Theatre nurse", category: "nursing" },
      { code: "SCRUB-NURSE", name: "Scrub nurse", category: "nursing" },
      { code: "CIRC-NURSE", name: "Circulating nurse", category: "nursing" },
      { code: "RECOVERY-NURSE", name: "Recovery nurse", category: "nursing" },
      { code: "THEATRE-TECH", name: "Theatre technician", category: "technical" },
      { code: "THEATRE-SCHED", name: "Theatre scheduler", category: "administrative" },
    ],
  },
  {
    code: "LAB", name: "Laboratory and pathology", type: "laboratory",
    units: [
      { code: "LAB-COLLECT", name: "Specimen collection" },
      { code: "LAB-HEME", name: "Hematology" },
      { code: "LAB-CHEM", name: "Clinical chemistry" },
      { code: "LAB-MICRO", name: "Microbiology" },
      { code: "LAB-HISTO", name: "Histopathology and cytology" },
      { code: "LAB-OTHER", name: "Other supported laboratory specialties" },
    ],
    cadres: [
      { code: "PATHOLOGIST", name: "Pathologist", category: "medical" },
      { code: "LAB-SCIENTIST", name: "Laboratory scientist or technologist", category: "laboratory" },
      { code: "LAB-TECH", name: "Laboratory technician", category: "laboratory" },
      { code: "PHLEBOTOMIST", name: "Phlebotomist", category: "laboratory" },
      { code: "LAB-ASST", name: "Laboratory assistant", category: "support" },
      { code: "LAB-QA", name: "Laboratory quality officer", category: "quality" },
    ],
  },
  {
    code: "BLOOD", name: "Blood bank and transfusion services", type: "blood-bank",
    units: [
      { code: "BLOOD-DONOR", name: "Donor services" },
      { code: "BLOOD-TEST", name: "Testing and compatibility" },
      { code: "BLOOD-ISSUE", name: "Issue and return" },
    ],
    cadres: [
      { code: "TRANSFUSION-SPEC", name: "Transfusion specialist", category: "medical" },
      { code: "BLOOD-TECH", name: "Blood-bank technologist or technician", category: "laboratory" },
      { code: "DONOR-STAFF", name: "Donor services staff", category: "laboratory" },
      { code: "TRANSFUSION-NURSE", name: "Authorized transfusion nurse", category: "nursing" },
      { code: "TRANSFUSION-COORD", name: "Transfusion coordinator", category: "administration" },
    ],
  },
  {
    code: "RAD", name: "Radiology and medical imaging", type: "radiology",
    units: [
      { code: "RAD-XRAY", name: "General radiography" },
      { code: "RAD-US", name: "Ultrasound" },
      { code: "RAD-CT", name: "CT" },
      { code: "RAD-MRI", name: "MRI" },
      { code: "RAD-OTHER", name: "Other supported modalities" },
    ],
    cadres: [
      { code: "RADIOLOGIST", name: "Radiologist", category: "medical" },
      { code: "RADIOGRAPHER", name: "Radiographer", category: "radiology" },
      { code: "SONOGRAPHER", name: "Sonographer", category: "radiology" },
      { code: "IMAGING-NURSE", name: "Imaging nurse", category: "nursing" },
      { code: "IMAGING-ASST", name: "Imaging assistant", category: "support" },
      { code: "PACS-ADMIN", name: "PACS administrator", category: "technical" },
      { code: "IMAGING-SCHED", name: "Imaging scheduler", category: "administrative" },
    ],
  },
  {
    code: "PHARM", name: "Pharmacy and medicines management", type: "pharmacy",
    units: [
      { code: "PHARM-OUT", name: "Outpatient pharmacy" },
      { code: "PHARM-IN", name: "Inpatient pharmacy" },
      { code: "PHARM-STORE", name: "Medicines store" },
    ],
    cadres: [
      { code: "PHARMACIST", name: "Pharmacist", category: "pharmacy" },
      { code: "PHARM-TECH", name: "Pharmacy technician", category: "pharmacy" },
      { code: "PHARM-ASST", name: "Pharmacy assistant", category: "pharmacy" },
      { code: "MED-STORE", name: "Medicines-store officer", category: "pharmacy" },
      { code: "CLIN-PHARM", name: "Clinical pharmacist", category: "pharmacy" },
    ],
  },
  {
    code: "RENAL", name: "Renal services", type: "renal",
    units: [
      { code: "RENAL-CLINIC", name: "Renal clinic" },
      { code: "RENAL-DIALYSIS", name: "Dialysis" },
    ],
    cadres: [
      { code: "NEPHROLOGIST", name: "Nephrologist", category: "medical" },
      { code: "RENAL-MO", name: "Medical officer", category: "medical" },
      { code: "DIALYSIS-NURSE", name: "Dialysis nurse", category: "nursing" },
      { code: "DIALYSIS-TECH", name: "Dialysis technician", category: "technical" },
    ],
  },
  {
    code: "MH", name: "Mental health", type: "mental-health",
    units: [
      { code: "MH-CLINIC", name: "Mental-health clinic" },
      { code: "MH-INPATIENT", name: "Mental-health inpatient care" },
    ],
    cadres: [
      { code: "PSYCHIATRIST", name: "Psychiatrist", category: "medical" },
      { code: "PSYCH-CLIN-OFF", name: "Psychiatric clinical officer", category: "clinical" },
      { code: "MH-NURSE", name: "Mental-health nurse", category: "nursing" },
      { code: "PSYCHOLOGIST", name: "Psychologist", category: "allied-health" },
      { code: "COUNSELLOR", name: "Counsellor", category: "counselling" },
      { code: "SOCIAL-WORKER", name: "Social worker", category: "social" },
    ],
  },
  {
    code: "REHAB", name: "Rehabilitation and allied health", type: "rehabilitation",
    units: [
      { code: "REHAB-PT", name: "Physiotherapy" },
      { code: "REHAB-OT", name: "Occupational therapy" },
      { code: "REHAB-SLT", name: "Speech and language therapy" },
    ],
    cadres: [
      { code: "PHYSIO", name: "Physiotherapist", category: "allied-health" },
      { code: "OT", name: "Occupational therapist", category: "allied-health" },
      { code: "SLT", name: "Speech and language therapist", category: "allied-health" },
      { code: "AUDIOLOGIST", name: "Audiologist", category: "allied-health" },
      { code: "PROSTHETIST", name: "Prosthetist or orthotist", category: "allied-health" },
      { code: "REHAB-ASST", name: "Rehabilitation assistant", category: "support" },
    ],
  },
  {
    code: "NUT", name: "Nutrition and dietetics", type: "nutrition",
    units: [
      { code: "NUT-CLINIC", name: "Nutrition clinic" },
      { code: "NUT-KITCHEN", name: "Therapeutic diets" },
    ],
    cadres: [
      { code: "DIETITIAN", name: "Dietitian", category: "allied-health" },
      { code: "NUTRITIONIST", name: "Nutritionist", category: "allied-health" },
      { code: "NUT-ASST", name: "Nutrition assistant", category: "support" },
    ],
  },
  {
    code: "DENTAL", name: "Dental and oral health", type: "dental",
    units: [
      { code: "DENTAL-CLINIC", name: "Dental clinic" },
      { code: "DENTAL-LAB", name: "Dental laboratory" },
    ],
    cadres: [
      { code: "DENTIST", name: "Dentist", category: "dental" },
      { code: "DENTAL-THERAPIST", name: "Dental therapist", category: "dental" },
      { code: "DENTAL-OFF", name: "Dental officer", category: "dental" },
      { code: "DENTAL-NURSE", name: "Dental nurse or assistant", category: "nursing" },
      { code: "DENTAL-TECH", name: "Dental technician", category: "technical" },
    ],
  },
  {
    code: "EYEENT", name: "Eye and ENT services", type: "eye-ent",
    units: [
      { code: "EYE-CLINIC", name: "Ophthalmology clinic" },
      { code: "ENT-CLINIC", name: "ENT clinic" },
      { code: "AUDIOLOGY", name: "Audiology" },
    ],
    cadres: [
      { code: "OPHTHALMOLOGIST", name: "Ophthalmologist", category: "medical" },
      { code: "OPTOMETRIST", name: "Optometrist", category: "allied-health" },
      { code: "OPHTHAL-OFF", name: "Ophthalmic clinical officer or nurse", category: "clinical" },
      { code: "ENT-SPEC", name: "ENT specialist", category: "medical" },
      { code: "ENT-NURSE", name: "ENT nurse", category: "nursing" },
      { code: "AUDIOLOGY-PRAC", name: "Audiology practitioner", category: "allied-health" },
    ],
  },
  {
    code: "COMM", name: "Primary, community and public health", type: "primary-community",
    units: [
      { code: "COMM-PREV", name: "Preventive services" },
      { code: "COMM-IMM", name: "Immunization" },
      { code: "COMM-SCREEN", name: "Screening" },
      { code: "COMM-OUTREACH", name: "Community outreach" },
      { code: "COMM-SURV", name: "Surveillance" },
      { code: "COMM-CHRONIC", name: "Chronic-care programmes" },
    ],
    cadres: [
      { code: "PH-OFF", name: "Public health officer", category: "public-health" },
      { code: "CHN", name: "Community health nurse", category: "nursing" },
      { code: "CHW", name: "Community health worker", category: "public-health" },
      { code: "EPIDEMIOLOGIST", name: "Epidemiologist", category: "public-health" },
      { code: "HEALTH-ED", name: "Health educator", category: "public-health" },
      { code: "PROG-COORD", name: "Programme coordinator", category: "administration" },
      { code: "SURV-OFF", name: "Surveillance or data officer", category: "public-health" },
    ],
  },
  {
    code: "PALL", name: "Hospice, palliative care and social support", type: "palliative",
    units: [
      { code: "PALL-CLINIC", name: "Palliative-care clinic" },
      { code: "PALL-HOME", name: "Home-care coordination" },
      { code: "PALL-BEREAVE", name: "Bereavement support" },
    ],
    cadres: [
      { code: "PALL-CLIN", name: "Palliative-care clinician", category: "medical" },
      { code: "PALL-NURSE", name: "Palliative-care nurse", category: "nursing" },
      { code: "PALL-SOCIAL", name: "Social worker", category: "social" },
      { code: "PALL-COUNS", name: "Counsellor", category: "counselling" },
      { code: "CHAPLAIN", name: "Chaplain or spiritual-care provider", category: "social" },
      { code: "HOME-COORD", name: "Home-care coordinator", category: "administration" },
    ],
  },
  {
    code: "IPC", name: "Infection prevention, quality and patient safety", type: "ipc-quality",
    units: [
      { code: "IPC-SURV", name: "Infection surveillance" },
      { code: "IPC-QI", name: "Quality improvement" },
      { code: "IPC-SAFETY", name: "Patient safety" },
    ],
    cadres: [
      { code: "IPC-PRAC", name: "IPC practitioner", category: "quality" },
      { code: "QI-OFF", name: "Quality improvement officer", category: "quality" },
      { code: "SAFETY-OFF", name: "Patient safety officer", category: "quality" },
      { code: "OCC-HEALTH", name: "Occupational health practitioner", category: "medical" },
      { code: "ENV-HEALTH", name: "Environmental health officer", category: "public-health" },
    ],
  },
  {
    code: "CSSD", name: "Central sterile services", type: "cssd",
    units: [
      { code: "CSSD-DECON", name: "Decontamination" },
      { code: "CSSD-PREP", name: "Instrument preparation" },
      { code: "CSSD-STER", name: "Sterilization" },
      { code: "CSSD-STORE", name: "Sterile storage and distribution" },
    ],
    cadres: [
      { code: "CSSD-TECH", name: "Sterile services technician", category: "technical" },
      { code: "DECON-TECH", name: "Decontamination technician", category: "technical" },
      { code: "CSSD-SUP", name: "CSSD supervisor", category: "technical" },
    ],
  },
  {
    code: "MORT", name: "Mortuary and bereavement services", type: "mortuary",
    units: [
      { code: "MORT-RECEPTION", name: "Reception and identification" },
      { code: "MORT-STORAGE", name: "Storage" },
      { code: "MORT-PREP", name: "Authorized preparation" },
      { code: "MORT-PM", name: "Post-mortem coordination" },
      { code: "MORT-RELEASE", name: "Release and family liaison" },
    ],
    cadres: [
      { code: "MORT-ATT", name: "Mortuary attendant", category: "mortuary" },
      { code: "MORT-TECH", name: "Mortuary technician", category: "mortuary" },
      { code: "MORT-SUP", name: "Mortuary supervisor", category: "mortuary" },
      { code: "FORENSIC", name: "Pathologist or forensic practitioner", category: "medical" },
      { code: "BEREAVE-OFF", name: "Bereavement or family liaison officer", category: "social" },
      { code: "MORT-TRANSPORT", name: "Authorized transport staff", category: "support" },
    ],
  },
  {
    code: "ENV", name: "Environmental services, housekeeping and laundry", type: "housekeeping",
    units: [
      { code: "ENV-ROUTINE", name: "Routine cleaning" },
      { code: "ENV-TERMINAL", name: "Terminal and discharge cleaning" },
      { code: "ENV-ISO", name: "Isolation-area cleaning" },
      { code: "ENV-LAUNDRY", name: "Laundry and linen" },
      { code: "ENV-WASTE", name: "Waste handling" },
      { code: "ENV-WASH", name: "WASH coordination" },
    ],
    cadres: [
      { code: "CLEANER", name: "Cleaner or housekeeper", category: "support" },
      { code: "HK-SUP", name: "Housekeeping supervisor", category: "support" },
      { code: "LAUNDRY-ATT", name: "Laundry attendant", category: "support" },
      { code: "LINEN-ATT", name: "Linen-store attendant", category: "support" },
      { code: "WASTE-HANDLER", name: "Waste handler", category: "support" },
      { code: "ENV-MGR", name: "Environmental services manager", category: "administration" },
    ],
  },
  {
    code: "PORT", name: "Portering, orderlies and logistics", type: "portering",
    units: [
      { code: "PORT-PATIENT", name: "Patient transport" },
      { code: "PORT-SPECIMEN", name: "Specimen courier" },
      { code: "PORT-LOGISTICS", name: "Internal logistics" },
    ],
    cadres: [
      { code: "ORDERLY", name: "Hospital orderly", category: "support" },
      { code: "PORTER", name: "Patient porter", category: "support" },
      { code: "SPEC-COURIER", name: "Specimen courier", category: "support" },
      { code: "LOGISTICS-ASST", name: "Internal logistics assistant", category: "support" },
      { code: "TRANSPORT-COORD", name: "Transport coordinator", category: "administration" },
    ],
  },
  {
    code: "ENG", name: "Facilities engineering and biomedical services", type: "engineering",
    units: [
      { code: "ENG-BIOMED", name: "Biomedical engineering" },
      { code: "ENG-FAC", name: "Facilities maintenance" },
      { code: "ENG-GAS", name: "Medical gases" },
    ],
    cadres: [
      { code: "BIOMED", name: "Biomedical engineer or technician", category: "technical" },
      { code: "MAINT-TECH", name: "Maintenance technician", category: "technical" },
      { code: "ELECTRICIAN", name: "Electrician", category: "technical" },
      { code: "PLUMBER", name: "Plumber", category: "technical" },
      { code: "GAS-TECH", name: "Medical-gas technician", category: "technical" },
      { code: "FAC-MGR", name: "Facilities manager", category: "administration" },
    ],
  },
  {
    code: "CATER", name: "Catering and food services", type: "catering",
    units: [
      { code: "CATER-KITCHEN", name: "Main kitchen" },
      { code: "CATER-WARD", name: "Ward meal distribution" },
    ],
    cadres: [
      { code: "CATER-MGR", name: "Catering manager", category: "administration" },
      { code: "COOK", name: "Cook or chef", category: "support" },
      { code: "FOOD-ATT", name: "Food-service attendant", category: "support" },
      { code: "KITCHEN-ASST", name: "Kitchen assistant", category: "support" },
    ],
  },
  {
    code: "SEC", name: "Security and safety", type: "security",
    units: [
      { code: "SEC-GATE", name: "Access control" },
      { code: "SEC-PATROL", name: "Patrol and response" },
    ],
    cadres: [
      { code: "SEC-OFF", name: "Security officer", category: "support" },
      { code: "SEC-SUP", name: "Security supervisor", category: "support" },
      { code: "FIRE-SAFETY", name: "Fire or safety officer", category: "support" },
    ],
  },
  {
    code: "FIN", name: "Finance, revenue and insurance", type: "finance",
    units: [
      { code: "FIN-CASH", name: "Cashiering" },
      { code: "FIN-BILL", name: "Billing" },
      { code: "FIN-CLAIMS", name: "Claims" },
      { code: "FIN-AR", name: "Accounts receivable" },
    ],
    cadres: [
      { code: "ACCOUNTANT", name: "Accountant", category: "finance" },
      { code: "CASHIER", name: "Cashier", category: "finance" },
      { code: "BILLING-OFF", name: "Billing officer", category: "finance" },
      { code: "CLAIMS-OFF", name: "Claims officer", category: "finance" },
      { code: "REVENUE-MGR", name: "Revenue manager", category: "finance" },
      { code: "INTERNAL-AUDITOR", name: "Internal auditor", category: "finance" },
    ],
  },
  {
    code: "HR", name: "Human resources, education and research", type: "hr",
    units: [
      { code: "HR-OPS", name: "HR operations" },
      { code: "HR-CRED", name: "Credentialing" },
      { code: "HR-TRAIN", name: "Training and education" },
      { code: "HR-RESEARCH", name: "Research administration" },
    ],
    cadres: [
      { code: "HR-OFF", name: "HR officer", category: "administration" },
      { code: "CRED-OFF", name: "Credentialing officer", category: "administration" },
      { code: "TRAIN-COORD", name: "Training coordinator", category: "education" },
      { code: "CLIN-EDUCATOR", name: "Clinical educator", category: "education" },
      { code: "RESEARCH-COORD", name: "Research coordinator", category: "research" },
      { code: "RESEARCH-STAFF", name: "Authorized research staff", category: "research" },
    ],
  },
  {
    code: "PROC", name: "Procurement, stores and assets", type: "procurement",
    units: [
      { code: "PROC-BUY", name: "Procurement" },
      { code: "PROC-STORE", name: "General stores" },
      { code: "PROC-ASSET", name: "Asset management" },
    ],
    cadres: [
      { code: "PROC-OFF", name: "Procurement officer", category: "administration" },
      { code: "STOREKEEPER", name: "Storekeeper", category: "support" },
      { code: "SUPPLY-OFF", name: "Supply-chain officer", category: "administration" },
      { code: "ASSET-OFF", name: "Asset officer", category: "administration" },
    ],
  },
  {
    code: "IT", name: "Digital health, IT and data governance", type: "digital-health",
    units: [
      { code: "IT-OPS", name: "IT operations" },
      { code: "IT-INTEGRATION", name: "Integration services" },
      { code: "IT-DATA", name: "Data and analytics" },
      { code: "IT-PRIVACY", name: "Privacy and data protection" },
    ],
    cadres: [
      { code: "IT-ADMIN", name: "IT administrator", category: "technical" },
      { code: "APP-SUPPORT", name: "Application support officer", category: "technical" },
      { code: "INTEGRATION-ENG", name: "Integration engineer", category: "technical" },
      { code: "DATA-ANALYST", name: "Data analyst", category: "data" },
      { code: "SEC-OFFICER", name: "Security officer", category: "security" },
      { code: "PRIVACY-OFF", name: "Privacy or data protection officer", category: "governance" },
    ],
  },
];

export const DEFAULT_PRIVILEGES = [
  { code: "CLIN-ASSESS", name: "Clinical assessment and documentation", category: "clinical" as const, requiresCredential: false },
  { code: "CLIN-SIGN", name: "Sign clinical notes and amendments", category: "clinical" as const, requiresCredential: true },
  { code: "PRESCRIBE", name: "Prescribe medicines", category: "prescribing" as const, requiresCredential: true },
  { code: "ORDER-DIAG", name: "Order diagnostic investigations", category: "diagnostic" as const, requiresCredential: false },
  { code: "LAB-VERIFY", name: "Verify and release laboratory results", category: "diagnostic" as const, requiresCredential: true },
  { code: "RAD-REPORT", name: "Report imaging studies", category: "diagnostic" as const, requiresCredential: true },
  { code: "THEATRE-SCRUB", name: "Scrub for theatre procedures", category: "theatre" as const, requiresCredential: false },
  { code: "THEATRE-ANES", name: "Provide anesthesia", category: "theatre" as const, requiresCredential: true },
  { code: "MAT-LABOUR", name: "Provide labour and delivery care", category: "maternity" as const, requiresCredential: true },
  { code: "MAT-NEWBORN", name: "Provide newborn assessment and care", category: "maternity" as const, requiresCredential: false },
  { code: "CRIT-CARE", name: "Provide critical-care management", category: "critical-care" as const, requiresCredential: true },
  { code: "PHARM-DISPENSE", name: "Dispense medicines", category: "pharmacy" as const, requiresCredential: true },
  { code: "PHARM-CHECK", name: "Perform medication review", category: "pharmacy" as const, requiresCredential: true },
  { code: "MORT-RELEASE", name: "Authorize mortuary release", category: "mortuary" as const, requiresCredential: false },
  { code: "CSSD-RELEASE", name: "Release sterilized loads", category: "technical" as const, requiresCredential: false },
  { code: "ADMIN-APPROVE", name: "Administrative approval within delegated limit", category: "administrative" as const, requiresCredential: false },
];
