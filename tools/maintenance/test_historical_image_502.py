import copy
import unittest
from historical_image_502 import transition

def fixture():
    spec = {"count":3,"resolution":"4K","aspect_ratio":"16:9"}
    u = {"id":"unit","payload_hash":"hash","index":0,"output_offset":0,"output_count":3,"status":"pending"}
    r = {"version":"published_image_receipt_v3","task_id":"fixture","status":"unknown","billing_state":"pending","expected_count":3,"pending_count":3,"units":[u],"quote":{"owner":{"user_id":2,"api_key_id":3},"binding":{"spec":spec}},"request":"unchanged"}
    o = {"id":"unit","payload_hash":"hash","state":"unknown","upstream_id":""}
    j = {"task_id":"fixture","owner":2,"keyRef":3,"status":"unknown","quote":{"spec":spec},"results":[]}
    return r,o,j

class MaintenanceTest(unittest.TestCase):
    def test_preserves_identity_and_price(self):
        r,o,j=fixture(); originals=copy.deepcopy((r,o,j));v=transition(r,o,j)
        self.assertEqual((r,o,j),originals)
        self.assertEqual(v["receipt"]["quote"],r["quote"])
        self.assertEqual(v["receipt"]["request"],r["request"])
        self.assertEqual(v["receipt"]["failed_count"],3)
        self.assertEqual(v["outcome"]["http_failure"],{"status":502,"response_hash":"","no_charge_final":True})
        self.assertEqual(v["journal"]["billing_state"],"not_charged")
    def test_conflicts_rejected(self):
        for target,key,value in [(0,"status","completed"),(0,"billing_state","billed"),(0,"result_hash","image"),(0,"delivered_count",1),(1,"data","YWJj"),(1,"state","response"),(1,"id","other"),(2,"owner",99),(2,"results",["image"]),(2,"settled_price",{"amount":"1"})]:
            with self.subTest(key=key,value=value):
                f=fixture();f[target][key]=value
                with self.assertRaises(AssertionError):transition(*f)
    def test_repeated_transition_refused(self):
        v=transition(*fixture())
        with self.assertRaises(AssertionError):transition(v["receipt"],v["outcome"],v["journal"])

if __name__=="__main__":unittest.main()
