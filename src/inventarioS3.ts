import {
    S3Client,
    ListBucketsCommand,
    GetBucketPolicyStatusCommand,
    GetPublicAccessBlockCommand,
    GetBucketLocationCommand,
} from "@aws-sdk/client-s3";
import {
    CloudWatchClient,
    GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const s3 = new S3Client({ region: "us-east-1" });
const cloudwatch = new CloudWatchClient({ region: "us-east-1" });

async function generarInventario() {
    const bucketsData: any[] = [];

    console.log("Obteniendo lista de buckets...");

    const { Buckets } = await s3.send(new ListBucketsCommand({}));

    if (!Buckets || Buckets.length === 0) {
        console.log("No se encontraron buckets.");
        return;
    }

    const regionDeseada = "us-east-1";


    const bucketsEnRegion = [];

    for (const bucket of Buckets || []) {
        const location = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name! }));
        const bucketRegion = location.LocationConstraint || "us-east-1"; 
        if (bucketRegion === regionDeseada) {
            bucketsEnRegion.push(bucket);
        }
    }


    for (const bucket of bucketsEnRegion) {


        const name = bucket.Name!;
        console.log(`BucketS3: ${name}`);

        try {
            const access = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }))
                .catch((err: any) => {
                    if (err.Code === "NoSuchPublicAccessBlockConfiguration") {
                        return { PublicAccessBlockConfiguration: true };
                    }
                    throw err;
                });

            const policy = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: name }))
                .catch((err: any) => {
                    if (err.Code === "NoSuchBucketPolicy") {
                        return { PolicyStatus: { IsPublic: false } };
                    }
                    throw err;
                });

            const tamano = await obtenerMetricas(name, "BucketSizeBytes", "StandardStorage");
            const numeroObjetos = await obtenerMetricas(name, "NumberOfObjects", "AllStorageTypes");

            bucketsData.push({
                nombre: name,
                creacion: bucket.CreationDate,
                tamano: tamano?.value,
                numeroObjetos: numeroObjetos?.value,
                accesoPublico: accessPublic(access?.PublicAccessBlockConfiguration),
                bucketPolicy: policy?.PolicyStatus?.IsPublic,
                deleteFlag: evaluarBucket(tamano?.value, numeroObjetos?.value, policy?.PolicyStatus?.IsPublic || false)

            });
            console.log(" Inventario generado: inventario-s3.json");
        } catch (error) {
            console.error("Error inesperado procesando el bucket:", name, error);
        }
    }
    await exportToExcel(bucketsData);
}

generarInventario().catch(console.error);

interface BucketInfo {
    nombre: string;
    creacion: string;
    tamano: number;
    numeroObjetos: number;
    accesoPublico: boolean;
    bucketPolicy: boolean;
    deleteFlag: {
        importancia: string,
        posibleEliminar: boolean
    }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, "file", "inventarioS3CR.xlsx");

export async function exportToExcel(dataBucket: BucketInfo[]) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];

    let startRow = 4; 
    const startCol = 4; 

    for (const obj of dataBucket) {
        let col = startCol;


        const valores = [
            obj.nombre,
            obj.creacion,
            obj.tamano,
            obj.numeroObjetos,
            obj.accesoPublico ? "Sí" : "No",
            obj.bucketPolicy ? "Sí" : "No",
            obj.deleteFlag.importancia,
            obj.deleteFlag.posibleEliminar
        ];

        for (const valor of valores) {
            sheet.getCell(startRow, col).value = valor ?? "";
            col++;
        }

        startRow++; 
    }

    await workbook.xlsx.writeFile(filePath);
    console.log("✅ Datos escritos correctamente en el Excel.");
}



async function obtenerMetricas(bucketName: string, metricName: string, storageType: string) {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const command = new GetMetricStatisticsCommand({
        Namespace: "AWS/S3",
        MetricName: metricName,
        Dimensions: [
            { Name: "BucketName", Value: bucketName },
            { Name: "StorageType", Value: storageType },
        ],
        StartTime: start,
        EndTime: end,
        Period: 86400,
        Statistics: ["Average"],
    });

    const data = await cloudwatch.send(command);
    const datapoints = data.Datapoints ?? [];

    if (datapoints.length === 0) {
        return null;
    }

    const latest = datapoints.sort(
        (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0)
    )[0];

    return {
        timestamp: latest.Timestamp,
        value: latest.Average ?? 0,
        unit: latest.Unit ?? "Bytes",
    };
}

type AccesoPublico = {
    BlockPublicAcls?: boolean;
    IgnorePublicAcls?: boolean;
    BlockPublicPolicy?: boolean;
    RestrictPublicBuckets?: boolean;
};

export function accessPublic(acceso: AccesoPublico | null): boolean {
    if (!acceso) return true;
    const {
        BlockPublicAcls,
        IgnorePublicAcls,
        BlockPublicPolicy,
        RestrictPublicBuckets,
    } = acceso;

    const bloqueadoTotal =
        BlockPublicAcls &&
        IgnorePublicAcls &&
        BlockPublicPolicy &&
        RestrictPublicBuckets;

    return bloqueadoTotal;
}

type EvaluacionBucket = {
    importancia: "irrelevante" | "importante" | "critico";
    posibleEliminar: boolean;
};

function evaluarBucket(tamanoBytes: number, accesoPublico: boolean, policyPublica: boolean): EvaluacionBucket {
    let score = 0;

    const GB = 1024 * 1024 * 1024;

    if (tamanoBytes > 100 * GB) score += 3;
    else if (tamanoBytes > 10 * GB) score += 2;
    else score += 1;

    score += accesoPublico ? 3 : 1;

    score += policyPublica ? 3 : 1;

    let importancia: EvaluacionBucket = { importancia: "irrelevante", posibleEliminar: false };

    if (score <= 4) {
        importancia = { importancia: "irrelevante", posibleEliminar: true };
    } else if (score <= 7) {
        importancia = { importancia: "importante", posibleEliminar: false };
    } else {
        importancia = { importancia: "critico", posibleEliminar: false };
    }

    return importancia;
}
