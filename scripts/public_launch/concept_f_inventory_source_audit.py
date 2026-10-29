"""Static mapping triage only; never confers functional/visual/hosted acceptance."""
import csv,json,re,hashlib,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def source_path(record):
    text=str(record.get('source_file') or record.get('source') or record.get('evidence_source') or '')
    match=re.search(r'((?:frontend|backend)/[^:#@\s]+)',text)
    return match.group(1) if match else None

def audit():
    result={'schema_version':1,'kind':'static_source_presence_not_feature_acceptance','source_sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'tracked_changes_present':bool(subprocess.check_output(['git','diff','--name-only','HEAD'],cwd=ROOT,text=True).strip()),'limits':['Both inventories overlap; do not sum as unique features.','A file or matching label does not establish mounted access, safe behavior, reference parity or hosted acceptance.','Inherited source line numbers refer to older revisions; current matching lines are only literal-label hints.'],'source_files':{},'inventories':{}}
    for name in ('main','supplement'):
        rows=list(csv.DictReader((ROOT/f'docs/concept-f/inventory-{name}.csv').open()));items=[]
        for row in rows:
            record=json.loads(row['original_record']);path=source_path(record);file=ROOT/path if path else None
            safe=bool(file and file.is_relative_to(ROOT) and file.is_file());body=file.read_text(errors='replace') if safe else '';label=str(record.get('exact_feature_control') or record.get('feature') or '')
            matches=[index for index,line in enumerate(body.splitlines(),1) if label and label in line][:10]
            if path and path not in result['source_files']:result['source_files'][path]={'present':safe,'sha256':hashlib.sha256(body.encode()).hexdigest() if safe else None}
            items.append({'id':row['id'],'screen':row['concept_f_screen'],'legacy_source_path':path,'legacy_file_present':safe,'literal_label_line_hints':matches,'current_implementation_path':row['implementation_path'] or None,'current_test_reference':row['test_id'] or None,'qualification':row['behavior_status'],'functional_accepted':False,'visual_accepted':False,'hosted_accepted':False})
        result['inventories'][name]={'rows':len(items),'legacy_file_present':sum(row['legacy_file_present'] for row in items),'explicit_partial_caller_mappings':sum(row['current_implementation_path'] is not None for row in items),'items':items}
    return result
if __name__=='__main__':
    result=audit();target=ROOT/'docs/concept-f/inventory-source-triage.json';target.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:{field:value[field] for field in ('rows','legacy_file_present','explicit_partial_caller_mappings')} for key,value in result['inventories'].items()}))
