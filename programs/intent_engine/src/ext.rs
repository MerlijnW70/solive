use anchor_lang::prelude::borsh::io::{Error, ErrorKind, Read, Result as IoResult, Write};
use anchor_lang::prelude::*;
use intent_core::ext::{validate, EXT_MAX_LEN};

use crate::errors::core_err;

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Ext(pub Vec<u8>);

impl Ext {
    pub fn check(&self, known: &[u8]) -> Result<()> {
        validate(&self.0, known).map_err(core_err)?;
        Ok(())
    }
}

impl AnchorSerialize for Ext {
    fn serialize<W: Write>(&self, writer: &mut W) -> IoResult<()> {
        self.0.serialize(writer)
    }
}

impl AnchorDeserialize for Ext {
    fn deserialize_reader<R: Read>(reader: &mut R) -> IoResult<Self> {
        let len = usize::try_from(u32::deserialize_reader(reader)?)
            .ok()
            .filter(|n| *n <= EXT_MAX_LEN)
            .ok_or_else(|| Error::from(ErrorKind::InvalidData))?;
        let mut bytes = vec![0u8; len];
        reader.read_exact(&mut bytes)?;
        Ok(Self(bytes))
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::idl::build::IdlBuild for Ext {
    fn create_type() -> Option<anchor_lang::idl::types::IdlTypeDef> {
        Some(anchor_lang::idl::types::IdlTypeDef {
            name: Self::get_full_path(),
            docs: Vec::new(),
            serialization: anchor_lang::idl::types::IdlSerialization::Borsh,
            repr: None,
            generics: Vec::new(),
            ty: anchor_lang::idl::types::IdlTypeDefTy::Type {
                alias: anchor_lang::idl::types::IdlType::Bytes,
            },
        })
    }

    fn get_full_path() -> String {
        format!("{}::Ext", module_path!())
    }
}
